import assert from "node:assert/strict";
import { test } from "node:test";
import { computeFreshness, matchQuote, postProcessJudgement } from "../src/judge.ts";
import type { Source } from "../src/types.ts";

const sources: Source[] = [
  {
    n: 1,
    title: "Intel Appoints Lip-Bu Tan as Chief Executive Officer",
    url: "https://www.intel.com/newsroom/lip-bu-tan",
    content: "SANTA CLARA, Calif., March 12, 2025 – Intel Corporation today announced that its board of directors has appointed Lip-Bu Tan as chief executive officer.",
  },
  { n: 2, title: "Intel - Wikipedia", url: "https://en.wikipedia.org/wiki/Intel", content: "Pat Gelsinger retired as CEO in December 2024." },
];

test("matchQuote: exact, near-verbatim, and fabricated quotes", () => {
  assert.equal(matchQuote("its board of directors has appointed Lip-Bu Tan as chief executive officer", sources[0]), "exact");
  assert.equal(matchQuote("“Its board of directors has appointed Lip-Bu Tan as Chief Executive Officer.”", sources[0]), "exact");
  assert.equal(matchQuote("Intel Corporation announced its board of directors has appointed Lip-Bu Tan as chief executive officer", sources[0]), "near");
  assert.equal(matchQuote("Lip-Bu Tan was fired by the board in 2026 after a scandal", sources[0]), null);
  assert.equal(matchQuote("short", sources[0]), null);
});

test("postProcessJudgement keeps verified evidence and separates inference", () => {
  const out = postProcessJudgement(
    {
      verdict: "changed",
      confidence: 0.92,
      evidence: [
        { source: 1, quote: "its board of directors has appointed Lip-Bu Tan as chief executive officer" },
        { source: 2, quote: "Pat Gelsinger is still running Intel today" },
        { source: 7, quote: "anything" },
      ],
      inference: "Lip-Bu Tan replaced Gelsinger, so the claim is outdated.",
      current_value: "Lip-Bu Tan",
    },
    sources,
  );
  assert.equal(out.verdict, "changed");
  assert.equal(out.confidence, 0.92);
  assert.equal(out.evidence.length, 1);
  assert.equal(out.evidence[0].url, "https://www.intel.com/newsroom/lip-bu-tan");
  assert.equal(out.evidence[0].match, "exact");
  assert.equal(out.currentValue, "Lip-Bu Tan");
  assert.match(out.inference, /replaced/);
  assert.equal(out.notes.length, 2);
  assert.ok(out.notes.some((n) => n.includes("not found in source [2]")));
  assert.ok(out.notes.some((n) => n.includes("unknown source [7]")));
});

test("postProcessJudgement downgrades a verdict that has no verifiable evidence", () => {
  const out = postProcessJudgement(
    { verdict: "supported", confidence: 0.95, evidence: [{ source: 1, quote: "Pat Gelsinger leads Intel" }], inference: "x" },
    sources,
  );
  assert.equal(out.verdict, "unverifiable");
  assert.ok(out.confidence <= 0.5);
  assert.ok(out.notes.some((n) => n.startsWith("downgraded")));
});

test("postProcessJudgement handles unknown verdicts, bad confidence, and null current_value", () => {
  const out = postProcessJudgement({ verdict: "maybe", confidence: "abc", current_value: "null" }, sources);
  assert.equal(out.verdict, "unverifiable");
  assert.equal(out.confidence, 0.5);
  assert.equal(out.currentValue, null);
  const sup = postProcessJudgement(
    { verdict: "SUPPORTED", confidence: 3, evidence: [{ source: "2", quote: "Pat Gelsinger retired as CEO in December 2024" }], current_value: "x" },
    sources,
  );
  assert.equal(sup.verdict, "supported");
  assert.equal(sup.confidence, 1);
  assert.equal(sup.currentValue, null, "current_value only kept for changed");
});

test("computeFreshness maps verdict and confidence to an indicator", () => {
  assert.deepEqual(computeFreshness("supported", 0.9, 2), { score: 95, label: "fresh", confidence: "high" });
  assert.deepEqual(computeFreshness("changed", 0.9, 1), { score: 5, label: "stale", confidence: "medium" });
  assert.deepEqual(computeFreshness("changed", 0.4, 1), { score: 30, label: "stale", confidence: "low" });
  assert.deepEqual(computeFreshness("unverifiable", 0.9, 0), { score: null, label: "unknown", confidence: "low" });
});
