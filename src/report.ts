// Aggregation: per audited model and per topic, how often were time-sensitive
// claims confirmed vs out of date. Plus the auditor's own run facts (which
// model served its calls, fallbacks, virtual-key usage, Tavily calls).

import type { VirtualKeyUsage } from "./bifrost.ts";
import type { AnswerAudit, ClaimResult, ModelUse } from "./types.ts";

export interface Tally {
  answers: number;
  claims: number;
  checked: number;
  supported: number;
  changed: number;
  unverifiable: number;
  skipped: number;
  /** changed / (supported + changed); null when nothing could be decided. */
  stalenessRate: number | null;
}

export interface RoutingRuleSuggestion {
  id: string;
  name: string;
  description: string;
  cel_expression: string;
  targets: { provider: string; model: string; weight: number }[];
  enabled: boolean;
  priority: number;
  scope: "global";
}

export interface FreshnessReport {
  generatedAt: string;
  today: string;
  mode: "logs" | "check" | "eval";
  gateway: { baseUrl: string; vkBefore: VirtualKeyUsage | null; vkAfter: VirtualKeyUsage | null };
  auditor: {
    primaryModel: string;
    fallbackModels: string[];
    calls: number;
    fallbackCalls: number;
    servedBy: Record<string, number>;
    promptTokens: number;
    completionTokens: number;
    stoppedEarly: string | null;
  };
  tavily: { callsThisRun: number; creditsThisRun: number; ledgerTotalCalls: number | null };
  totals: Tally;
  byModel: Record<string, Tally>;
  byCategory: Record<string, Tally>;
  routingSuggestions: RoutingRuleSuggestion[];
  audits: AnswerAudit[];
}

export function emptyTally(): Tally {
  return { answers: 0, claims: 0, checked: 0, supported: 0, changed: 0, unverifiable: 0, skipped: 0, stalenessRate: null };
}

function addClaim(t: Tally, c: ClaimResult): void {
  t.claims += 1;
  if (c.skipped) {
    t.skipped += 1;
    return;
  }
  t.checked += 1;
  t[c.verdict] += 1;
}

function finish(t: Tally): Tally {
  const decided = t.supported + t.changed;
  t.stalenessRate = decided > 0 ? Math.round((t.changed / decided) * 1000) / 1000 : null;
  return t;
}

export function tallyAudits(audits: AnswerAudit[]): {
  totals: Tally;
  byModel: Record<string, Tally>;
  byCategory: Record<string, Tally>;
} {
  const totals = emptyTally();
  const byModel: Record<string, Tally> = {};
  const byCategory: Record<string, Tally> = {};
  for (const a of audits) {
    const model = a.source.model ?? "(direct input)";
    byModel[model] ??= emptyTally();
    byModel[model].answers += 1;
    totals.answers += 1;
    for (const c of a.claims) {
      addClaim(totals, c);
      addClaim(byModel[model], c);
      // Topic view counts only claims that were researched.
      if (c.skipped === "not_time_sensitive") continue;
      byCategory[c.claim.category] ??= emptyTally();
      addClaim(byCategory[c.claim.category], c);
    }
  }
  finish(totals);
  Object.values(byModel).forEach(finish);
  Object.values(byCategory).forEach(finish);
  return { totals, byModel, byCategory };
}

export function summarizeCalls(calls: ModelUse[]) {
  const servedBy: Record<string, number> = {};
  let fallbackCalls = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  for (const c of calls) {
    servedBy[c.served] = (servedBy[c.served] ?? 0) + 1;
    if (c.isFallback) fallbackCalls += 1;
    promptTokens += c.promptTokens;
    completionTokens += c.completionTokens;
  }
  return { calls: calls.length, fallbackCalls, servedBy, promptTokens, completionTokens };
}

function splitModel(m: string): { provider: string; model: string } {
  const i = m.indexOf("/");
  return i > 0 ? { provider: m.slice(0, i), model: m.slice(i + 1) } : { provider: "", model: m };
}

/**
 * Suggest Bifrost routing rules that move time-sensitive traffic (requests the
 * application tags with `x-freshness-sensitive: true`) away from models whose
 * staleness rate is at or above `threshold`, toward the freshest audited model.
 * Output uses the field names of Bifrost's governance.routing_rules config.
 */
export function suggestRoutingRules(
  byModel: Record<string, Tally>,
  o: { threshold?: number; minDecided?: number } = {},
): RoutingRuleSuggestion[] {
  const threshold = o.threshold ?? 0.34;
  const minDecided = o.minDecided ?? 2;
  const eligible = Object.entries(byModel).filter(
    ([m, t]) => m.includes("/") && t.stalenessRate !== null && t.supported + t.changed >= minDecided,
  );
  if (eligible.length < 2) return [];
  const freshest = [...eligible].sort((a, b) => (a[1].stalenessRate ?? 1) - (b[1].stalenessRate ?? 1))[0];
  const target = splitModel(freshest[0]);
  const out: RoutingRuleSuggestion[] = [];
  for (const [m, t] of eligible) {
    if (m === freshest[0] || (t.stalenessRate ?? 0) < threshold) continue;
    if ((t.stalenessRate ?? 0) <= (freshest[1].stalenessRate ?? 0)) continue;
    const src = splitModel(m);
    const slug = src.model.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase();
    out.push({
      id: `freshness-avoid-${slug}`,
      name: `Freshness: route time-sensitive ${src.model} traffic to ${target.model}`,
      description:
        `${m} was stale on ${t.changed}/${t.supported + t.changed} researched claims ` +
        `(${Math.round((t.stalenessRate ?? 0) * 100)}%) vs ${Math.round((freshest[1].stalenessRate ?? 0) * 100)}% for ${freshest[0]}.`,
      cel_expression: `provider == "${src.provider}" && model == "${src.model}" && headers["x-freshness-sensitive"] == "true"`,
      targets: [{ provider: target.provider, model: target.model, weight: 1.0 }],
      enabled: true,
      priority: 10,
      scope: "global",
    });
  }
  return out;
}
