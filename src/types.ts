// Shared types. Only erasable TypeScript syntax is used so Node can run the
// sources directly (node >= 22.18 strips types natively; no build step).

export type Verdict = "supported" | "changed" | "unverifiable";

export const CATEGORIES = [
  "price",
  "version",
  "office_holder",
  "law",
  "statistic",
  "schedule",
  "product",
  "other",
] as const;
export type Category = (typeof CATEGORIES)[number];

export type Sensitivity = "high" | "medium" | "low";

export interface Claim {
  id: string;
  text: string;
  category: Category;
  timeSensitive: boolean;
  sensitivity: Sensitivity;
  searchQuery: string;
}

/** One web source returned by Tavily, numbered for the judge prompt. */
export interface Source {
  n: number;
  title: string;
  url: string;
  content: string;
  score?: number;
  publishedDate?: string;
}

/** A quote the judge cited. `match` records whether we could find it in the source text. */
export interface EvidenceQuote {
  source: number;
  url: string;
  quote: string;
  match: "exact" | "near";
}

/** Which model actually served an LLM call made through Bifrost. */
export interface ModelUse {
  purpose: "extract" | "judge";
  requested: string;
  served: string;
  isFallback: boolean;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
}

export interface Freshness {
  /** 0 = certainly stale, 100 = certainly current, null = unknown. */
  score: number | null;
  label: "fresh" | "stale" | "unknown";
  confidence: "high" | "medium" | "low";
}

export type SkipReason = "not_time_sensitive" | "tavily_cap" | "governance_limit" | "error";

export interface ClaimResult {
  claim: Claim;
  verdict: Verdict;
  /** 0..1, as reported by the judge after our post-processing. */
  confidence: number;
  freshness: Freshness;
  /** Evidence: verbatim (or near-verbatim) text found in a cited source. */
  evidence: EvidenceQuote[];
  /** Inference: the judge's own reasoning. Never presented as evidence. */
  inference: string;
  currentValue: string | null;
  sources: Source[];
  notes: string[];
  judge?: ModelUse;
  skipped?: SkipReason;
}

export interface AnswerSource {
  kind: "bifrost_log" | "direct";
  logId?: string;
  provider?: string;
  model?: string;
  timestamp?: string;
  virtualKey?: string | null;
}

export interface AnswerAudit {
  source: AnswerSource;
  question: string | null;
  answer: string;
  claims: ClaimResult[];
  extract?: ModelUse;
  error?: string;
}
