// Measures the detector on a labeled claim set: does it flag time-sensitive
// claims, and does it reach the right verdict after live research?

import { readFileSync } from "node:fs";
import type { Runtime } from "./app.ts";
import { extractClaims } from "./extract.ts";
import { checkClaim, RunState, type PipelineDeps } from "./pipeline.ts";
import type { Category, Claim, ClaimResult, Verdict } from "./types.ts";

export interface LabeledClaim {
  id: string;
  text: string;
  category: Category;
  expected_time_sensitive: boolean;
  expected_verdict: Verdict | null;
  truth_note: string;
}

export interface EvalRow {
  id: string;
  text: string;
  expectedSensitive: boolean;
  predictedSensitive: boolean;
  expectedVerdict: Verdict | null;
  predictedVerdict: Verdict | null;
  correct: boolean | null;
  freshnessScore: number | null;
  evidenceCount: number;
  currentValue: string | null;
  servedBy: string | null;
  notes: string[];
  topSource: string | null;
}

export interface EvalSummary {
  n: number;
  sensitivity: { correct: number; total: number; accuracy: number };
  verdict: { correct: number; total: number; accuracy: number; confusion: Record<string, Record<string, number>> };
  staleDetection: { precision: number | null; recall: number | null; f1: number | null };
  downgradedForMissingEvidence: number;
  tavilyCalls: number;
  llmCalls: number;
  fallbackCalls: number;
}

export function loadDataset(path: string): LabeledClaim[] {
  const data = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(data)) throw new Error("dataset must be a JSON array");
  return data as LabeledClaim[];
}

/** Pure scoring over evaluated rows; unit-tested. */
export function scoreRows(rows: EvalRow[]): Omit<EvalSummary, "tavilyCalls" | "llmCalls" | "fallbackCalls"> {
  const sensCorrect = rows.filter((r) => r.expectedSensitive === r.predictedSensitive).length;
  const labels: Verdict[] = ["supported", "changed", "unverifiable"];
  const confusion: Record<string, Record<string, number>> = {};
  for (const e of labels) confusion[e] = Object.fromEntries([...labels, "none"].map((p) => [p, 0]));
  const judged = rows.filter((r) => r.expectedVerdict !== null);
  let correct = 0;
  for (const r of judged) {
    confusion[r.expectedVerdict as string][r.predictedVerdict ?? "none"] += 1;
    if (r.expectedVerdict === r.predictedVerdict) correct += 1;
  }
  const tp = judged.filter((r) => r.expectedVerdict === "changed" && r.predictedVerdict === "changed").length;
  const fp = judged.filter((r) => r.expectedVerdict !== "changed" && r.predictedVerdict === "changed").length;
  const fn = judged.filter((r) => r.expectedVerdict === "changed" && r.predictedVerdict !== "changed").length;
  const precision = tp + fp > 0 ? tp / (tp + fp) : null;
  const recall = tp + fn > 0 ? tp / (tp + fn) : null;
  const f1 = precision !== null && recall !== null && precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : null;
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  return {
    n: rows.length,
    sensitivity: { correct: sensCorrect, total: rows.length, accuracy: rows.length ? r3(sensCorrect / rows.length) : 0 },
    verdict: { correct, total: judged.length, accuracy: judged.length ? r3(correct / judged.length) : 0, confusion },
    staleDetection: {
      precision: precision === null ? null : r3(precision),
      recall: recall === null ? null : r3(recall),
      f1: f1 === null ? null : r3(f1),
    },
    downgradedForMissingEvidence: rows.filter((r) => r.notes.some((n) => n.startsWith("downgraded"))).length,
  };
}

export async function runEval(
  rt: Runtime,
  dataset: LabeledClaim[],
  log: (m: string) => void,
): Promise<{ rows: EvalRow[]; summary: EvalSummary; results: ClaimResult[] }> {
  const deps: PipelineDeps = { bifrost: rt.bifrost, tavily: rt.tavily, today: rt.settings.today, log };
  const state = new RunState();
  const rows: EvalRow[] = [];
  const results: ClaimResult[] = [];
  for (const [i, item] of dataset.entries()) {
    // 1) Sensitivity: run the real extractor on the claim as if it were an answer.
    const ex = await extractClaims(rt.bifrost, item.text, null, rt.settings.today, 3);
    const first: Claim | undefined = ex.claims[0];
    const predictedSensitive = first ? first.timeSensitive && first.sensitivity !== "low" : false;
    // 2) Verdict: research every claim that is labeled time-sensitive, using the
    //    extractor's own search query, so verdict accuracy is measured even when
    //    step 1 misses (that miss is counted separately above).
    let r: ClaimResult | null = null;
    if (item.expected_verdict !== null) {
      const claim: Claim = {
        id: item.id,
        text: item.text,
        category: item.category,
        timeSensitive: true,
        sensitivity: "high",
        searchQuery: first?.searchQuery || item.text,
      };
      r = await checkClaim(claim, deps, state);
      results.push(r);
    }
    const row: EvalRow = {
      id: item.id,
      text: item.text,
      expectedSensitive: item.expected_time_sensitive,
      predictedSensitive,
      expectedVerdict: item.expected_verdict,
      predictedVerdict: r ? r.verdict : null,
      correct: r ? r.verdict === item.expected_verdict : null,
      freshnessScore: r ? r.freshness.score : null,
      evidenceCount: r ? r.evidence.length : 0,
      currentValue: r ? r.currentValue : null,
      servedBy: r?.judge?.served ?? null,
      notes: r ? r.notes : [],
      topSource: r?.evidence[0]?.url ?? r?.sources[0]?.url ?? null,
    };
    rows.push(row);
    log(
      `[${i + 1}/${dataset.length}] ${item.id} sensitive ${predictedSensitive ? "Y" : "N"}/${item.expected_time_sensitive ? "Y" : "N"}` +
        (r ? `  verdict ${r.verdict}/${item.expected_verdict} ${row.correct ? "OK" : "MISS"}` : ""),
    );
  }
  const calls = rt.bifrost.calls;
  const summary: EvalSummary = {
    ...scoreRows(rows),
    tavilyCalls: rt.tavily.callsThisRun,
    llmCalls: calls.length,
    fallbackCalls: calls.filter((c) => c.isFallback).length,
  };
  return { rows, summary, results };
}

export function evalMarkdown(rows: EvalRow[], s: EvalSummary, meta: { today: string; model: string }): string {
  const pct = (x: number | null) => (x === null ? "n/a" : `${(x * 100).toFixed(1)}%`);
  const c = s.verdict.confusion;
  const lines = [
    `# Evaluation results`,
    ``,
    `Reference date ${meta.today}. Judge/extractor: \`${meta.model}\` via Bifrost. Live Tavily search, one query per claim.`,
    ``,
    `| metric | value |`,
    `|---|---|`,
    `| claims | ${s.n} |`,
    `| time-sensitivity flag accuracy | ${s.sensitivity.correct}/${s.sensitivity.total} (${pct(s.sensitivity.accuracy)}) |`,
    `| verdict accuracy (supported / changed / unverifiable) | ${s.verdict.correct}/${s.verdict.total} (${pct(s.verdict.accuracy)}) |`,
    `| stale ("changed") precision | ${pct(s.staleDetection.precision)} |`,
    `| stale ("changed") recall | ${pct(s.staleDetection.recall)} |`,
    `| stale F1 | ${pct(s.staleDetection.f1)} |`,
    `| verdicts downgraded for missing verbatim evidence | ${s.downgradedForMissingEvidence} |`,
    `| Tavily searches | ${s.tavilyCalls} |`,
    `| LLM calls through Bifrost (fallback-served) | ${s.llmCalls} (${s.fallbackCalls}) |`,
    ``,
    `Confusion matrix (rows = expected, columns = predicted):`,
    ``,
    `| expected \\ predicted | supported | changed | unverifiable | none |`,
    `|---|---|---|---|---|`,
    ...(["supported", "changed", "unverifiable"] as const).map(
      (e) => `| ${e} | ${c[e].supported} | ${c[e].changed} | ${c[e].unverifiable} | ${c[e].none} |`,
    ),
    ``,
    `| id | claim | sensitive (pred/exp) | verdict (pred/exp) | freshness | current value | evidence |`,
    `|---|---|---|---|---|---|---|`,
    ...rows.map(
      (r) =>
        `| ${r.id} | ${r.text.replace(/\|/g, "/")} | ${r.predictedSensitive ? "Y" : "N"}/${r.expectedSensitive ? "Y" : "N"} | ` +
        `${r.predictedVerdict ?? "-"}/${r.expectedVerdict ?? "-"}${r.correct === false ? " **MISS**" : ""} | ${r.freshnessScore ?? "-"} | ` +
        `${(r.currentValue ?? "").replace(/\|/g, "/")} | ${r.topSource ? `[link](${r.topSource})` : "-"} |`,
    ),
    ``,
  ];
  return lines.join("\n");
}
