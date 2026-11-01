// Orchestrates extract -> search -> judge for one answer, and degrades
// gracefully: a Tavily cap or a Bifrost governance refusal stops further
// checks but keeps every result gathered so far.

import { GovernanceLimitError, type BifrostClient } from "./bifrost.ts";
import { extractClaims } from "./extract.ts";
import { computeFreshness, judgeClaim } from "./judge.ts";
import { TavilyCapError, type TavilyClient } from "./tavily.ts";
import type { AnswerAudit, AnswerSource, Claim, ClaimResult, SkipReason } from "./types.ts";

export interface PipelineDeps {
  bifrost: BifrostClient;
  tavily: TavilyClient;
  today: string;
  maxClaims?: number;
  /** Only claims flagged time-sensitive are researched. "high" narrows further to high sensitivity. */
  minSensitivity?: "medium" | "high";
  log?: (msg: string) => void;
}

/** Set once a governance limit is hit so later answers in the same run are skipped too. */
export class RunState {
  stopped: { reason: SkipReason; message: string } | null = null;
}

export function skippedResult(claim: Claim, reason: SkipReason, note: string): ClaimResult {
  return {
    claim,
    verdict: "unverifiable",
    confidence: 0,
    freshness: computeFreshness("unverifiable", 0, 0),
    evidence: [],
    inference: "",
    currentValue: null,
    sources: [],
    notes: [note],
    skipped: reason,
  };
}

export function shouldResearch(claim: Claim, min: "medium" | "high" = "medium"): boolean {
  if (!claim.timeSensitive) return false;
  if (min === "high") return claim.sensitivity === "high";
  return claim.sensitivity !== "low";
}

/** Research and judge a single claim. Used by the audit pipeline and the evaluation harness. */
export async function checkClaim(claim: Claim, deps: PipelineDeps, state: RunState): Promise<ClaimResult> {
  if (state.stopped) return skippedResult(claim, state.stopped.reason, state.stopped.message);
  let sources;
  try {
    sources = await deps.tavily.search(claim.searchQuery);
  } catch (e) {
    if (e instanceof TavilyCapError) return skippedResult(claim, "tavily_cap", e.message);
    return skippedResult(claim, "error", `search failed: ${(e as Error).message}`);
  }
  try {
    const j = await judgeClaim(deps.bifrost, claim, sources, deps.today);
    return {
      claim,
      verdict: j.verdict,
      confidence: j.confidence,
      freshness: computeFreshness(j.verdict, j.confidence, j.evidence.length),
      evidence: j.evidence,
      inference: j.inference,
      currentValue: j.currentValue,
      sources,
      notes: j.notes,
      judge: j.use,
    };
  } catch (e) {
    if (e instanceof GovernanceLimitError) {
      state.stopped = { reason: "governance_limit", message: `Bifrost ${e.kind} limit: ${e.message}` };
      return { ...skippedResult(claim, "governance_limit", state.stopped.message), sources };
    }
    return { ...skippedResult(claim, "error", `judge failed: ${(e as Error).message}`), sources };
  }
}

export async function auditAnswer(
  input: { source: AnswerSource; question: string | null; answer: string },
  deps: PipelineDeps,
  state: RunState = new RunState(),
): Promise<AnswerAudit> {
  const audit: AnswerAudit = { ...input, claims: [] };
  const log = deps.log ?? (() => {});
  if (state.stopped) {
    audit.error = `skipped: ${state.stopped.message}`;
    return audit;
  }
  let claims: Claim[];
  try {
    const r = await extractClaims(deps.bifrost, input.answer, input.question, deps.today, deps.maxClaims ?? 6);
    claims = r.claims;
    audit.extract = r.use;
    if (r.use.isFallback) log(`  ! primary model unavailable, ${r.use.served} took over (extract)`);
  } catch (e) {
    if (e instanceof GovernanceLimitError) {
      state.stopped = { reason: "governance_limit", message: `Bifrost ${e.kind} limit: ${e.message}` };
    }
    audit.error = `extraction failed: ${(e as Error).message}`;
    return audit;
  }
  log(`  ${claims.length} claim(s), ${claims.filter((c) => shouldResearch(c, deps.minSensitivity)).length} time-sensitive`);
  for (const claim of claims) {
    if (!shouldResearch(claim, deps.minSensitivity)) {
      audit.claims.push(skippedResult(claim, "not_time_sensitive", "not time-sensitive; not researched"));
      continue;
    }
    const r = await checkClaim(claim, deps, state);
    if (r.judge?.isFallback) log(`  ! primary model unavailable, ${r.judge.served} took over (judge)`);
    log(`  [${r.skipped ? `skipped: ${r.skipped}` : r.verdict}] ${claim.text}`);
    audit.claims.push(r);
  }
  return audit;
}
