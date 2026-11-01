import assert from "node:assert/strict";
import { test } from "node:test";
import { BifrostClient } from "../src/bifrost.ts";
import { evalMarkdown, scoreRows, type EvalRow } from "../src/eval.ts";
import { esc, renderHtml } from "../src/html.ts";
import { auditAnswer, RunState } from "../src/pipeline.ts";
import { summarizeCalls, suggestRoutingRules, tallyAudits, type FreshnessReport } from "../src/report.ts";
import { TavilyClient } from "../src/tavily.ts";
import type { AnswerAudit, ClaimResult } from "../src/types.ts";
import { chatResponse, fakeFetch, isExtract, tavilyResponse, type Recorded } from "./helpers.ts";

const EXTRACTED = {
  claims: [
    { text: "Pat Gelsinger is the CEO of Intel.", category: "office_holder", time_sensitive: true, sensitivity: "high", search_query: "current CEO of Intel" },
    { text: "Intel was founded in 1968.", category: "other", time_sensitive: false, sensitivity: "low", search_query: "Intel founded" },
    { text: "Jensen Huang is the CEO of Nvidia.", category: "office_holder", time_sensitive: true, sensitivity: "high", search_query: "current CEO of Nvidia" },
  ],
};

function judgeReply(req: Recorded, fallback = false) {
  const user = String(req.body.messages[1].content);
  if (user.includes("Intel")) {
    return chatResponse(
      { verdict: "changed", confidence: 0.9, evidence: [{ source: 1, quote: "Lip-Bu Tan has been CEO of Intel since 2025" }], inference: "Gelsinger was replaced.", current_value: "Lip-Bu Tan" },
      { model: fallback ? "small" : "big", fallback },
    );
  }
  return chatResponse(
    { verdict: "supported", confidence: 0.85, evidence: [{ source: 1, quote: "Jensen Huang is the CEO of Nvidia" }], inference: "Still CEO.", current_value: null },
    { model: fallback ? "small" : "big", fallback },
  );
}

function deps(o: { judgeStatus?: number; fallbackJudge?: boolean; tavilyCap?: number } = {}) {
  const b = fakeFetch((req) => {
    if (isExtract(req)) return { body: chatResponse(EXTRACTED, { model: "big" }) };
    if (o.judgeStatus) return { status: o.judgeStatus, body: { error: { message: "token limit reached" } } };
    return { body: judgeReply(req, o.fallbackJudge) };
  });
  const t = fakeFetch((req) =>
    req.body.query.includes("Intel")
      ? { body: tavilyResponse([{ title: "Lip-Bu Tan", url: "https://en.wikipedia.org/wiki/Lip-Bu_Tan", content: "Lip-Bu Tan has been CEO of Intel since 2025." }]) }
      : { body: tavilyResponse([{ title: "Nvidia", url: "https://nvidia.test/about", content: "Jensen Huang is the CEO of Nvidia and its co-founder." }]) },
  );
  const bifrost = new BifrostClient({ baseUrl: "http://gw", virtualKey: "sk-bf-x", primaryModel: "ollama/big", fallbackModels: ["ollama/small"], fetchImpl: b.fetch });
  const tavily = new TavilyClient({ apiKey: "k", maxCalls: o.tavilyCap ?? 10, fetchImpl: t.fetch });
  return { d: { bifrost, tavily, today: "2026-11-02", maxClaims: 5 }, bifrostReqs: b.requests, tavilyReqs: t.requests };
}

const input = { source: { kind: "direct" as const, model: "ollama/app-model" }, question: "Who runs Intel and Nvidia?", answer: "Pat Gelsinger runs Intel..." };

test("auditAnswer: extract, research only time-sensitive claims, judge with evidence", async () => {
  const { d, tavilyReqs } = deps();
  const a = await auditAnswer(input, d);
  assert.equal(a.claims.length, 3);
  const [intel, founded, nvidia] = a.claims;
  assert.equal(intel.verdict, "changed");
  assert.equal(intel.currentValue, "Lip-Bu Tan");
  assert.equal(intel.freshness.label, "stale");
  assert.equal(intel.evidence[0].url, "https://en.wikipedia.org/wiki/Lip-Bu_Tan");
  assert.equal(intel.inference, "Gelsinger was replaced.");
  assert.equal(founded.skipped, "not_time_sensitive");
  assert.equal(nvidia.verdict, "supported");
  assert.equal(nvidia.freshness.label, "fresh");
  assert.deepEqual(tavilyReqs.map((r) => r.body.query), ["current CEO of Intel", "current CEO of Nvidia"]);
});

test("auditAnswer surfaces fallback use per call", async () => {
  const { d } = deps({ fallbackJudge: true });
  const logs: string[] = [];
  const a = await auditAnswer(input, { ...d, log: (m) => logs.push(m) });
  assert.equal(a.claims[0].judge?.isFallback, true);
  assert.equal(a.claims[0].judge?.served, "ollama/small");
  assert.ok(logs.some((l) => l.includes("ollama/small took over (judge)")));
  const s = summarizeCalls(d.bifrost.calls);
  assert.equal(s.calls, 3);
  assert.equal(s.fallbackCalls, 2);
  assert.deepEqual(s.servedBy, { "ollama/big": 1, "ollama/small": 2 });
});

test("a Bifrost governance limit stops the run but keeps partial results", async () => {
  const { d, tavilyReqs } = deps({ judgeStatus: 429 });
  const state = new RunState();
  const a = await auditAnswer(input, d, state);
  assert.equal(a.claims[0].skipped, "governance_limit");
  assert.equal(a.claims[2].skipped, "governance_limit");
  assert.equal(tavilyReqs.length, 1, "no further searches after the stop");
  assert.match(state.stopped?.message ?? "", /rate_limit limit: token limit reached/);
  const next = await auditAnswer(input, d, state);
  assert.match(next.error ?? "", /skipped/);
});

test("the Tavily cap marks remaining claims as skipped", async () => {
  const { d } = deps({ tavilyCap: 1 });
  const a = await auditAnswer(input, d);
  assert.equal(a.claims[0].verdict, "changed");
  assert.equal(a.claims[2].skipped, "tavily_cap");
});

function cr(verdict: ClaimResult["verdict"], category: ClaimResult["claim"]["category"], skipped?: ClaimResult["skipped"]): ClaimResult {
  return {
    claim: { id: "c", text: "t", category, timeSensitive: true, sensitivity: "high", searchQuery: "q" },
    verdict,
    confidence: 0.9,
    freshness: { score: 50, label: "unknown", confidence: "low" },
    evidence: [],
    inference: "",
    currentValue: null,
    sources: [],
    notes: [],
    skipped,
  };
}

function audit(model: string, claims: ClaimResult[]): AnswerAudit {
  return { source: { kind: "bifrost_log", model }, question: null, answer: "a", claims };
}

test("tallyAudits computes staleness per model and per topic", () => {
  const audits = [
    audit("ollama/old", [cr("changed", "version"), cr("changed", "office_holder"), cr("supported", "office_holder"), cr("unverifiable", "price", "not_time_sensitive")]),
    audit("ollama/new", [cr("supported", "version"), cr("supported", "office_holder"), cr("unverifiable", "price")]),
  ];
  const { totals, byModel, byCategory } = tallyAudits(audits);
  assert.equal(totals.answers, 2);
  assert.equal(totals.claims, 7);
  assert.equal(totals.checked, 6);
  assert.equal(totals.skipped, 1);
  assert.equal(byModel["ollama/old"].stalenessRate, 0.667);
  assert.equal(byModel["ollama/new"].stalenessRate, 0);
  assert.equal(byCategory.version.stalenessRate, 0.5);
  assert.equal(byCategory.price.claims, 1, "not-time-sensitive claims are excluded from the topic view");
  assert.equal(byCategory.price.stalenessRate, null);
});

test("suggestRoutingRules emits Bifrost routing_rules shape for stale models only", () => {
  const { byModel } = tallyAudits([
    audit("ollama/old", [cr("changed", "version"), cr("changed", "version"), cr("supported", "version")]),
    audit("ollama/new", [cr("supported", "version"), cr("supported", "version")]),
    audit("ollama/tiny", [cr("changed", "version")]),
  ]);
  const rules = suggestRoutingRules(byModel);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].id, "freshness-avoid-old");
  assert.equal(rules[0].cel_expression, 'provider == "ollama" && model == "old" && headers["x-freshness-sensitive"] == "true"');
  assert.deepEqual(rules[0].targets, [{ provider: "ollama", model: "new", weight: 1.0 }]);
  assert.deepEqual(suggestRoutingRules({ "ollama/old": byModel["ollama/old"] }), [], "needs a fresher alternative");
});

test("renderHtml escapes model output and separates evidence from inference", () => {
  const c = cr("changed", "version");
  c.claim.text = "<script>alert(1)</script>";
  c.inference = "reasoning <b>";
  c.evidence = [{ source: 1, url: "javascript:alert(1)", quote: "q", match: "exact" }];
  const report = {
    generatedAt: "now",
    today: "2026-11-02",
    mode: "check",
    gateway: { baseUrl: "http://gw", vkBefore: null, vkAfter: null },
    auditor: { primaryModel: "ollama/big", fallbackModels: [], calls: 0, fallbackCalls: 0, servedBy: {}, promptTokens: 0, completionTokens: 0, stoppedEarly: null },
    tavily: { callsThisRun: 0, creditsThisRun: 0, ledgerTotalCalls: null },
    ...tallyAudits([audit("ollama/x", [c])]),
    routingSuggestions: [],
    audits: [audit("ollama/x", [c])],
  } as FreshnessReport;
  const html = renderHtml(report);
  assert.ok(!html.includes("<script>alert(1)"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(!html.includes('href="javascript:'));
  assert.ok(html.includes("Inference <span class=\"muted\">(model reasoning, not evidence)</span>"));
  assert.equal(esc(`"'&`), "&quot;&#39;&amp;");
});

test("scoreRows computes accuracy, confusion matrix and stale precision/recall", () => {
  const row = (e: EvalRow["expectedVerdict"], p: EvalRow["predictedVerdict"], es = true, ps = true): EvalRow => ({
    id: "x", text: "t", expectedSensitive: es, predictedSensitive: ps, expectedVerdict: e, predictedVerdict: p,
    correct: e === null ? null : e === p, freshnessScore: null, evidenceCount: 0, currentValue: null, servedBy: null, notes: [], topSource: null,
  });
  const rows = [row("changed", "changed"), row("changed", "unverifiable"), row("supported", "supported"), row("supported", "changed"), row("unverifiable", "unverifiable"), row(null, null, false, true)];
  const s = scoreRows(rows);
  assert.equal(s.verdict.total, 5);
  assert.equal(s.verdict.correct, 3);
  assert.equal(s.verdict.accuracy, 0.6);
  assert.equal(s.verdict.confusion.changed.unverifiable, 1);
  assert.equal(s.staleDetection.precision, 0.5);
  assert.equal(s.staleDetection.recall, 0.5);
  assert.equal(s.sensitivity.correct, 5);
  const md = evalMarkdown(rows, { ...s, tavilyCalls: 5, llmCalls: 10, fallbackCalls: 0 }, { today: "2026-11-02", model: "ollama/big" });
  assert.match(md, /verdict accuracy .* 3\/5 \(60\.0%\)/);
});
