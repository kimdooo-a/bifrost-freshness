// Tavily search client with a hard per-run call cap and an optional on-disk
// ledger so the total number of calls across runs stays visible.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Source } from "./types.ts";

type FetchLike = typeof fetch;

export class TavilyCapError extends Error {
  constructor(cap: number) {
    super(`Tavily call cap reached (${cap} calls this run)`);
    this.name = "TavilyCapError";
  }
}

export interface TavilyOptions {
  apiKey: string;
  maxCalls: number;
  ledgerPath?: string | null;
  fetchImpl?: FetchLike;
  baseUrl?: string;
}

export interface SearchOptions {
  topic?: "general" | "news";
  maxResults?: number;
  timeRange?: "day" | "week" | "month" | "year";
}

interface Ledger {
  totalCalls: number;
  totalCredits: number;
  lastCallAt: string | null;
}

export class TavilyClient {
  private readonly opts: TavilyOptions;
  private readonly fetchImpl: FetchLike;
  callsThisRun = 0;
  creditsThisRun = 0;

  constructor(opts: TavilyOptions) {
    this.opts = opts;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get remaining(): number {
    return Math.max(0, this.opts.maxCalls - this.callsThisRun);
  }

  private readLedger(): Ledger {
    const p = this.opts.ledgerPath;
    if (p && existsSync(p)) {
      try {
        return JSON.parse(readFileSync(p, "utf8")) as Ledger;
      } catch {
        // corrupt ledger: start over rather than fail the audit
      }
    }
    return { totalCalls: 0, totalCredits: 0, lastCallAt: null };
  }

  ledger(): Ledger {
    return this.readLedger();
  }

  private record(credits: number): void {
    this.callsThisRun += 1;
    this.creditsThisRun += credits;
    const p = this.opts.ledgerPath;
    if (!p) return;
    const l = this.readLedger();
    l.totalCalls += 1;
    l.totalCredits += credits;
    l.lastCallAt = new Date().toISOString();
    writeFileSync(p, JSON.stringify(l, null, 2) + "\n");
  }

  async search(query: string, o: SearchOptions = {}): Promise<Source[]> {
    if (this.callsThisRun >= this.opts.maxCalls) throw new TavilyCapError(this.opts.maxCalls);
    const body: Record<string, unknown> = {
      query,
      search_depth: "basic",
      topic: o.topic ?? "general",
      max_results: o.maxResults ?? 5,
      include_answer: false,
      include_raw_content: false,
      include_usage: true,
    };
    if (o.timeRange) body.time_range = o.timeRange;
    const res = await this.fetchImpl(`${this.opts.baseUrl ?? "https://api.tavily.com"}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.opts.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, any>;
    // A request that reached Tavily counts against the budget even if it failed.
    this.record(Number(json?.usage?.credits ?? 1));
    if (!res.ok) {
      const detail = typeof json?.detail === "string" ? json.detail : JSON.stringify(json?.detail ?? "");
      throw new Error(`Tavily search failed (${res.status}) ${detail}`.trim());
    }
    const results: Record<string, any>[] = Array.isArray(json.results) ? json.results : [];
    return results.map((r, i) => ({
      n: i + 1,
      title: String(r.title ?? ""),
      url: String(r.url ?? ""),
      content: String(r.content ?? ""),
      score: typeof r.score === "number" ? r.score : undefined,
      publishedDate: typeof r.published_date === "string" ? r.published_date : undefined,
    }));
  }
}
