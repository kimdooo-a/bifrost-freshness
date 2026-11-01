// Step 3: judge one claim against the Tavily sources (LLM call through Bifrost),
// then check the judge's work in code:
//   * evidence quotes must actually appear in the cited source text, otherwise
//     they are dropped (the model's own words are inference, not evidence);
//   * a "supported"/"changed" verdict with no surviving quote is downgraded to
//     "unverifiable".

import type { BifrostClient } from "./bifrost.ts";
import { asNumber, asString, clamp } from "./json.ts";
import type { Claim, EvidenceQuote, Freshness, ModelUse, Source, Verdict } from "./types.ts";

const MAX_SOURCE_CHARS = 900;

export function judgePrompt(claim: Claim, sources: Source[], today: string) {
  const system = [
    "You are a fact-checker deciding whether a claim made by an AI assistant is still current.",
    `Today's date is ${today}. Judge ONLY from the numbered sources below, not from memory.`,
    "Verdicts:",
    '- "supported": the sources show the claim is still true as of today.',
    '- "changed": the sources show the claim used to be true or is now different',
    "  (e.g. a newer version, a different office holder, a new price). Put the current value in current_value.",
    '- "unverifiable": the sources do not address the claim, or conflict without a clear answer.',
    "Return ONLY a JSON object:",
    '{"verdict": "...", "confidence": 0.0-1.0,',
    ' "evidence": [{"source": <source number>, "quote": "<sentence copied character-for-character from that source>"}],',
    ' "inference": "<one or two sentences of your own reasoning linking the evidence to the verdict>",',
    ' "current_value": "<the current value if changed, else null>"}',
    "Quotes must be copied exactly from the source text. Your own reasoning goes ONLY in inference.",
    "If the sources only mention the claimed value as past history, that indicates changed, not supported.",
  ].join("\n");
  const blocks = sources.map((s) => {
    const date = s.publishedDate ? ` (published ${s.publishedDate})` : "";
    return `[${s.n}] ${s.title}${date}\nURL: ${s.url}\n${s.content.slice(0, MAX_SOURCE_CHARS)}`;
  });
  const user = `Claim: ${claim.text}\n\nSources:\n${blocks.join("\n\n") || "(no sources found)"}`;
  return { system, user };
}

function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’“”"'`]/g, "")
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function words(s: string): string[] {
  return normalizeText(s)
    .replace(/[^\p{L}\p{N}\s.-]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0);
}

/**
 * Locate a quote in a source. "exact" = normalized substring; "near" = at least
 * 90% of the quote's words appear in the source (tolerates ellipses and small
 * punctuation edits); null = not found, so it is not evidence.
 */
export function matchQuote(quote: string, source: Source): "exact" | "near" | null {
  const q = normalizeText(quote.replace(/\.\.\.|…/g, " "));
  if (q.length < 8) return null;
  const hay = normalizeText(`${source.title} ${source.content}`);
  if (hay.includes(q)) return "exact";
  const qw = words(q);
  if (qw.length < 4) return null;
  const hw = new Set(words(hay));
  const hit = qw.filter((w) => hw.has(w)).length;
  return hit / qw.length >= 0.9 ? "near" : null;
}

export interface JudgeOutcome {
  verdict: Verdict;
  confidence: number;
  evidence: EvidenceQuote[];
  inference: string;
  currentValue: string | null;
  notes: string[];
}

/** Validates the judge's JSON against the sources. Pure; unit-tested. */
export function postProcessJudgement(data: unknown, sources: Source[]): JudgeOutcome {
  const o = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const notes: string[] = [];
  let verdict = asString(o.verdict).toLowerCase() as Verdict;
  if (!["supported", "changed", "unverifiable"].includes(verdict)) {
    notes.push(`unknown verdict "${asString(o.verdict)}" treated as unverifiable`);
    verdict = "unverifiable";
  }
  let confidence = clamp(asNumber(o.confidence, 0.5), 0, 1);
  const evidence: EvidenceQuote[] = [];
  const raw = Array.isArray(o.evidence) ? o.evidence : [];
  for (const e of raw) {
    if (!e || typeof e !== "object") continue;
    const er = e as Record<string, unknown>;
    const n = Math.trunc(asNumber(er.source, -1));
    const quote = asString(er.quote);
    const src = sources.find((s) => s.n === n);
    if (!src) {
      notes.push(`dropped quote citing unknown source [${n}]`);
      continue;
    }
    const m = matchQuote(quote, src);
    if (!m) {
      notes.push(`dropped quote not found in source [${n}]: "${quote.slice(0, 80)}"`);
      continue;
    }
    evidence.push({ source: n, url: src.url, quote, match: m });
  }
  if (verdict !== "unverifiable" && evidence.length === 0) {
    notes.push(`downgraded "${verdict}" to unverifiable: no quote could be found in the sources`);
    verdict = "unverifiable";
    confidence = Math.min(confidence, 0.5);
  }
  const cv = asString(o.current_value);
  return {
    verdict,
    confidence,
    evidence,
    inference: asString(o.inference),
    currentValue: verdict === "changed" && cv && cv.toLowerCase() !== "null" ? cv : null,
    notes,
  };
}

/**
 * Freshness indicator shown per claim. Score 0..100: 100 = sources confirm it
 * is current, 0 = sources confirm it changed; unknown when unverifiable.
 */
export function computeFreshness(verdict: Verdict, confidence: number, evidenceCount: number): Freshness {
  const band: Freshness["confidence"] =
    confidence >= 0.8 && evidenceCount >= 2 ? "high" : confidence >= 0.6 && evidenceCount >= 1 ? "medium" : "low";
  if (verdict === "supported") return { score: Math.round(50 + 50 * confidence), label: "fresh", confidence: band };
  if (verdict === "changed") return { score: Math.round(50 - 50 * confidence), label: "stale", confidence: band };
  return { score: null, label: "unknown", confidence: "low" };
}

export async function judgeClaim(
  bifrost: BifrostClient,
  claim: Claim,
  sources: Source[],
  today: string,
): Promise<JudgeOutcome & { use: ModelUse }> {
  const { system, user } = judgePrompt(claim, sources, today);
  const r = await bifrost.chatJson(
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    "judge",
  );
  return { ...postProcessJudgement(r.data, sources), use: r.use };
}
