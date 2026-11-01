// Step 1: split an LLM answer into atomic factual claims and flag the ones
// whose truth can change over time. The LLM call goes through Bifrost.

import type { BifrostClient } from "./bifrost.ts";
import { asString } from "./json.ts";
import { CATEGORIES, type Category, type Claim, type ModelUse, type Sensitivity } from "./types.ts";

export function extractionPrompt(answer: string, question: string | null, today: string, maxClaims: number) {
  const system = [
    "You extract checkable factual claims from an AI assistant's answer.",
    `Today's date is ${today}.`,
    "Return ONLY a JSON object: {\"claims\": [ ... ]}. Each claim object has:",
    '- "text": one atomic, self-contained factual statement (resolve pronouns; keep names, numbers, versions, dates)',
    `- "category": one of ${CATEGORIES.join(", ")}`,
    '- "time_sensitive": true if the statement can become false over months or a few years',
    "  (prices, latest versions/releases, who holds an office or executive role, laws and regulations,",
    "  statistics, scheduled dates, product availability); false for stable facts (history, definitions, physics)",
    '- "sensitivity": "high" if it is very likely to have changed within 2 years, "medium" if it might, "low" otherwise',
    '- "search_query": a short web search query that would find the CURRENT value as of today.',
    "  Ask for the current value; do not copy the claimed value into the query.",
    `Extract at most ${maxClaims} claims, most time-sensitive first. Skip opinions, advice, and hedged statements.`,
    "If there are no factual claims, return {\"claims\": []}.",
  ].join("\n");
  const user = [question ? `User question:\n${question}\n` : "", `Assistant answer:\n${answer}`].join("\n");
  return { system, user };
}

const CATEGORY_ALIASES: Record<string, Category> = {
  pricing: "price",
  cost: "price",
  software_version: "version",
  release: "version",
  leadership: "office_holder",
  executive: "office_holder",
  politics: "office_holder",
  person: "office_holder",
  regulation: "law",
  legal: "law",
  stats: "statistic",
  number: "statistic",
  date: "schedule",
  event: "schedule",
};

export function normalizeCategory(raw: string): Category {
  const k = raw.toLowerCase().trim().replace(/[\s-]+/g, "_");
  if ((CATEGORIES as readonly string[]).includes(k)) return k as Category;
  return CATEGORY_ALIASES[k] ?? "other";
}

function normalizeSensitivity(raw: unknown, timeSensitive: boolean): Sensitivity {
  const s = typeof raw === "string" ? raw.toLowerCase().trim() : "";
  if (s === "high" || s === "medium" || s === "low") return s;
  return timeSensitive ? "medium" : "low";
}

function asBool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return ["true", "yes", "1"].includes(v.toLowerCase().trim());
  return false;
}

/** Validates and normalizes the extractor's JSON. Pure; unit-tested. */
export function parseClaims(data: unknown, maxClaims: number): Claim[] {
  const list = Array.isArray(data)
    ? data
    : data && typeof data === "object" && Array.isArray((data as Record<string, unknown>).claims)
      ? ((data as Record<string, unknown>).claims as unknown[])
      : [];
  const seen = new Set<string>();
  const out: Claim[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const text = asString(o.text ?? o.claim);
    if (text.length < 4) continue;
    const key = text.toLowerCase().replace(/\W+/g, " ").trim();
    if (seen.has(key)) continue;
    seen.add(key);
    const timeSensitive = asBool(o.time_sensitive ?? o.timeSensitive);
    out.push({
      id: `c${out.length + 1}`,
      text,
      category: normalizeCategory(asString(o.category, "other")),
      timeSensitive,
      sensitivity: normalizeSensitivity(o.sensitivity, timeSensitive),
      searchQuery: asString(o.search_query ?? o.searchQuery) || text,
    });
    if (out.length >= maxClaims) break;
  }
  return out;
}

export async function extractClaims(
  bifrost: BifrostClient,
  answer: string,
  question: string | null,
  today: string,
  maxClaims: number,
): Promise<{ claims: Claim[]; use: ModelUse }> {
  const { system, user } = extractionPrompt(answer, question, today, maxClaims);
  const r = await bifrost.chatJson(
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    "extract",
  );
  return { claims: parseClaims(r.data, maxClaims), use: r.use };
}
