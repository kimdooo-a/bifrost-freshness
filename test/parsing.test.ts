import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeCategory, parseClaims } from "../src/extract.ts";
import { parseJsonLoose } from "../src/json.ts";

test("parseJsonLoose accepts plain, fenced and prose-wrapped JSON", () => {
  assert.deepEqual(parseJsonLoose('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJsonLoose('```json\n{"a":2}\n```'), { a: 2 });
  assert.deepEqual(parseJsonLoose('Here you go: {"a":3} hope it helps'), { a: 3 });
  assert.throws(() => parseJsonLoose("no json here"), /not JSON/);
});

test("parseClaims normalizes fields, dedupes and caps", () => {
  const claims = parseClaims(
    {
      claims: [
        { text: "Pat Gelsinger is the CEO of Intel.", category: "Leadership", time_sensitive: "true", sensitivity: "HIGH", search_query: "current Intel CEO" },
        { text: "pat gelsinger is the CEO of intel", category: "executive", time_sensitive: true },
        { text: "Water boils at 100 C at sea level.", category: "science", time_sensitive: false },
        { text: "ok" },
        "not an object",
        { claim: "Python 3.11 is the latest release.", category: "software version", time_sensitive: true },
        { text: "Over the cap.", time_sensitive: true },
      ],
    },
    3,
  );
  assert.equal(claims.length, 3);
  assert.deepEqual(claims[0], {
    id: "c1",
    text: "Pat Gelsinger is the CEO of Intel.",
    category: "office_holder",
    timeSensitive: true,
    sensitivity: "high",
    searchQuery: "current Intel CEO",
  });
  assert.equal(claims[1].category, "other");
  assert.equal(claims[1].timeSensitive, false);
  assert.equal(claims[1].sensitivity, "low");
  assert.equal(claims[2].text, "Python 3.11 is the latest release.");
  assert.equal(claims[2].category, "version");
  assert.equal(claims[2].sensitivity, "medium", "missing sensitivity defaults from time_sensitive");
  assert.equal(claims[2].searchQuery, claims[2].text, "missing query falls back to the claim");
});

test("parseClaims accepts a bare array and garbage", () => {
  assert.equal(parseClaims([{ text: "A claim here", time_sensitive: true }], 5).length, 1);
  assert.deepEqual(parseClaims(null, 5), []);
  assert.deepEqual(parseClaims({ claims: "x" }, 5), []);
});

test("normalizeCategory maps aliases", () => {
  assert.equal(normalizeCategory("Pricing"), "price");
  assert.equal(normalizeCategory("office holder"), "office_holder");
  assert.equal(normalizeCategory("regulation"), "law");
  assert.equal(normalizeCategory("weather"), "other");
});
