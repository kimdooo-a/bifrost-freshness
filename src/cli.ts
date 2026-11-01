#!/usr/bin/env node
// bifrost-freshness CLI
//   audit  - audit recent answers from Bifrost's logs API
//   check  - audit one answer (--text, --file, or stdin)
//   serve  - HTTP API (POST /check)
//   eval   - accuracy on a labeled claim set
//   apply-rules - create the suggested routing rules via the management API

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { auditLogs, checkAnswer, createRuntime, writeReport } from "./app.ts";
import { loadSettings } from "./config.ts";
import { evalMarkdown, loadDataset, runEval } from "./eval.ts";
import type { FreshnessReport } from "./report.ts";
import { createApiServer } from "./server.ts";

const HELP = `bifrost-freshness - stale-answer auditor for a Bifrost gateway

Usage:
  node src/cli.ts audit [--since 2h|<ISO time>] [--limit 10] [--models a,b] [--max-claims 4] [--out reports]
  node src/cli.ts check (--text "..." | --file answer.txt | < answer.txt) [--question "..."] [--out reports]
  node src/cli.ts serve [--port 8787]
  node src/cli.ts eval [--dataset eval/labeled-claims.json] [--out eval/results]
  node src/cli.ts apply-rules --report <audit .json> [--dry-run]   create suggested routing rules in Bifrost

Common options:
  --primary <provider/model>     auditor's primary model (env FRESHNESS_PRIMARY_MODEL)
  --fallbacks <a,b>              auditor's fallback chain (env FRESHNESS_FALLBACK_MODELS)
  --name <file stem>             output file name (default: <command>-<timestamp>)
Configuration is read from environment variables or .env (see .env.example).`;

function parseSince(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const m = v.match(/^(\d+)([mhd])$/);
  if (m) {
    const ms = Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "m" | "h" | "d"];
    return new Date(Date.now() - ms).toISOString();
  }
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new Error(`--since: cannot parse "${v}"`);
  return d.toISOString();
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function printSummary(r: FreshnessReport): void {
  const a = r.auditor;
  console.log("");
  for (const au of r.audits) {
    for (const c of au.claims) {
      if (c.skipped === "not_time_sensitive") continue;
      const score = c.freshness.score === null ? " ?" : String(c.freshness.score).padStart(3);
      const tag = c.skipped ? `SKIP:${c.skipped}` : c.verdict.toUpperCase();
      console.log(`${tag.padEnd(13)} freshness ${score}  ${c.claim.text}`);
      if (c.currentValue) console.log(`${"".padEnd(13)} now: ${c.currentValue}`);
      if (c.evidence[0]) console.log(`${"".padEnd(13)} evidence: ${c.evidence[0].url}`);
    }
  }
  console.log("");
  console.log(`Totals: ${r.totals.checked} researched - ${r.totals.supported} supported, ${r.totals.changed} changed, ${r.totals.unverifiable} unverifiable`);
  const fb = a.fallbackCalls > 0 ? ` - ${a.fallbackCalls} served by FALLBACK (${Object.keys(a.servedBy).join(", ")})` : "";
  console.log(`Auditor LLM: ${a.calls} calls via Bifrost, primary ${a.primaryModel}${fb}`);
  const vk = r.gateway.vkAfter;
  if (vk) console.log(`Virtual key ${vk.id}: ${vk.tokensUsed}/${vk.tokenLimit} tokens, ${vk.requestsUsed}/${vk.requestLimit} requests in window`);
  console.log(`Tavily: ${r.tavily.callsThisRun} searches this run`);
  if (a.stoppedEarly) console.log(`STOPPED EARLY: ${a.stoppedEarly}`);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      since: { type: "string" },
      limit: { type: "string" },
      models: { type: "string" },
      "max-claims": { type: "string" },
      out: { type: "string" },
      name: { type: "string" },
      text: { type: "string" },
      file: { type: "string" },
      question: { type: "string" },
      model: { type: "string" },
      port: { type: "string" },
      dataset: { type: "string" },
      primary: { type: "string" },
      fallbacks: { type: "string" },
      report: { type: "string" },
      "dry-run": { type: "boolean" },
    },
    allowPositionals: false,
  });
  if (!cmd || cmd === "help" || cmd === "--help") {
    console.log(HELP);
    return;
  }
  const settings = loadSettings();
  if (values.primary) settings.primaryModel = values.primary;
  if (values.fallbacks !== undefined) settings.fallbackModels = values.fallbacks.split(",").map((s) => s.trim()).filter(Boolean);
  const rt = createRuntime(settings);
  const log = (m: string) => console.error(m);
  const maxClaims = Number(values["max-claims"] ?? 4);
  console.error(`Bifrost ${settings.bifrostUrl} - auditor primary ${settings.primaryModel}, fallbacks [${settings.fallbackModels.join(", ")}]`);

  if (cmd === "audit") {
    const report = await auditLogs(rt, {
      limit: Number(values.limit ?? 10),
      since: parseSince(values.since),
      models: values.models?.split(",").map((s) => s.trim()).filter(Boolean),
      maxClaims,
      log,
    });
    const paths = writeReport(report, values.out ?? "reports", values.name ?? `audit-${stamp()}`);
    printSummary(report);
    console.log(`Report: ${paths.html}\n        ${paths.json}`);
    if (report.routingSuggestions.length) console.log(`Suggested routing rules: ${report.routingSuggestions.map((r) => r.id).join(", ")}`);
    return;
  }
  if (cmd === "check") {
    const answer = values.text ?? (values.file ? readFileSync(values.file, "utf8") : readFileSync(0, "utf8"));
    if (!answer.trim()) throw new Error("no answer text given");
    const report = await checkAnswer(rt, { answer, question: values.question ?? null, model: values.model ?? null }, { maxClaims, log });
    const paths = writeReport(report, values.out ?? "reports", values.name ?? `check-${stamp()}`);
    printSummary(report);
    console.log(`Report: ${paths.html}\n        ${paths.json}`);
    return;
  }
  if (cmd === "serve") {
    const port = Number(values.port ?? 8787);
    createApiServer(rt, maxClaims, log).listen(port, "127.0.0.1", () => {
      console.log(`bifrost-freshness API on http://127.0.0.1:${port}  (POST /check, GET /health)`);
    });
    return;
  }
  if (cmd === "eval") {
    const dataset = loadDataset(values.dataset ?? "eval/labeled-claims.json");
    const { rows, summary, results } = await runEval(rt, dataset, log);
    const out = values.out ?? "eval/results";
    mkdirSync(out, { recursive: true });
    const meta = { today: settings.today, model: settings.primaryModel };
    writeFileSync(join(out, "eval-results.json"), JSON.stringify({ meta, summary, rows, results }, null, 2) + "\n");
    writeFileSync(join(out, "RESULTS.md"), evalMarkdown(rows, summary, meta));
    console.log(JSON.stringify(summary, null, 2));
    console.log(`Wrote ${join(out, "RESULTS.md")}`);
    return;
  }
  if (cmd === "apply-rules") {
    if (!values.report) throw new Error("apply-rules needs --report <audit report .json>");
    const report = JSON.parse(readFileSync(values.report, "utf8")) as FreshnessReport;
    if (report.routingSuggestions.length === 0) {
      console.log("Report has no routing suggestions; nothing to apply.");
      return;
    }
    for (const rule of report.routingSuggestions) {
      if (values["dry-run"]) {
        console.log(`[dry-run] would create: ${rule.name}\n  ${rule.cel_expression}`);
        continue;
      }
      const created = await rt.bifrost.createRoutingRule(rule);
      const id = created?.rule?.id ?? created?.id ?? "(id not returned)";
      console.log(`Created routing rule ${id}: ${rule.name}\n  ${rule.cel_expression}`);
    }
    return;
  }
  console.error(`unknown command "${cmd}"\n\n${HELP}`);
  process.exitCode = 2;
}

main().catch((e) => {
  console.error(`error: ${(e as Error).message}`);
  process.exitCode = 1;
});
