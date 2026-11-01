// Thin client for a stock Bifrost gateway.
//  - Inference: OpenAI-compatible POST /v1/chat/completions with a virtual key
//    (x-bf-vk) and a request-level `fallbacks` chain. Bifrost reports which
//    model actually answered in extra_fields.routing_info.
//  - Management: GET /api/logs, GET /api/logs/{id}, and
//    GET /api/governance/virtual-keys/{id}, authenticated with the admin
//    account (HTTP Basic) or, before an admin exists, the setup token.

import { parseJsonLoose } from "./json.ts";
import type { ModelUse } from "./types.ts";

type FetchLike = typeof fetch;

export interface BifrostClientOptions {
  baseUrl: string;
  virtualKey: string | null;
  adminUser?: string | null;
  adminPassword?: string | null;
  setupToken?: string | null;
  primaryModel: string;
  fallbackModels: string[];
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}

/** Raised when Bifrost governance refuses a call: 402 budget exceeded, 429 rate/token limit. */
export class GovernanceLimitError extends Error {
  status: number;
  kind: "budget" | "rate_limit";
  constructor(status: number, message: string) {
    super(message);
    this.name = "GovernanceLimitError";
    this.status = status;
    this.kind = status === 402 ? "budget" : "rate_limit";
  }
}

export class BifrostError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "BifrostError";
    this.status = status;
  }
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatJsonResult {
  data: unknown;
  text: string;
  use: ModelUse;
}

export interface LogListQuery {
  limit?: number;
  offset?: number;
  startTime?: string;
  endTime?: string;
  models?: string[];
  virtualKeyIds?: string[];
}

export interface VirtualKeyUsage {
  id: string;
  tokensUsed: number | null;
  tokenLimit: number | null;
  requestsUsed: number | null;
  requestLimit: number | null;
  budgets: { id: string; usedUsd: number; limitUsd: number; resetDuration: string }[];
}

function errorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object") {
    const e = (body as Record<string, unknown>).error;
    if (e && typeof e === "object" && typeof (e as Record<string, unknown>).message === "string") {
      return (e as Record<string, string>).message;
    }
    if (typeof e === "string") return e;
  }
  return fallback;
}

export class BifrostClient {
  readonly opts: BifrostClientOptions;
  /** Every LLM call this client made, in order. Used for the fallback report. */
  readonly calls: ModelUse[] = [];
  private readonly fetchImpl: FetchLike;

  constructor(opts: BifrostClientOptions) {
    this.opts = opts;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private adminHeaders(): Record<string, string> {
    const { adminUser, adminPassword, setupToken } = this.opts;
    if (adminUser && adminPassword) {
      const b64 = Buffer.from(`${adminUser}:${adminPassword}`).toString("base64");
      return { Authorization: `Basic ${b64}` };
    }
    if (setupToken) return { "X-Bifrost-Setup-Token": setupToken };
    return {};
  }

  private async request(path: string, init: RequestInit): Promise<{ status: number; body: unknown }> {
    const res = await this.fetchImpl(`${this.opts.baseUrl}${path}`, {
      ...init,
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 600_000),
    });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // keep raw text
    }
    return { status: res.status, body };
  }

  /** One JSON-mode chat completion through Bifrost, with the configured fallback chain. */
  async chatJson(messages: ChatMessage[], purpose: ModelUse["purpose"]): Promise<ChatJsonResult> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.opts.virtualKey) headers["x-bf-vk"] = this.opts.virtualKey;
    const payload = {
      model: this.opts.primaryModel,
      fallbacks: this.opts.fallbackModels,
      messages,
      temperature: 0,
      response_format: { type: "json_object" },
      // Local reasoning models think for minutes otherwise; the auditor only needs structured output.
      reasoning_effort: "none",
    };
    const started = Date.now();
    const { status, body } = await this.request("/v1/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    if (status === 402 || status === 429) {
      throw new GovernanceLimitError(status, errorMessage(body, `governance refused the call (${status})`));
    }
    if (status < 200 || status >= 300) {
      throw new BifrostError(status, errorMessage(body, `Bifrost returned ${status}`));
    }
    const b = body as Record<string, any>;
    const text: string = b?.choices?.[0]?.message?.content ?? "";
    const routing = b?.extra_fields?.routing_info ?? {};
    const servedProvider: string = routing.provider ?? b?.extra_fields?.provider ?? "";
    const servedModel: string = routing.model ?? b?.model ?? "";
    const use: ModelUse = {
      purpose,
      requested: this.opts.primaryModel,
      served: servedProvider ? `${servedProvider}/${servedModel}` : servedModel,
      isFallback: routing.is_fallback === true,
      promptTokens: Number(b?.usage?.prompt_tokens ?? 0),
      completionTokens: Number(b?.usage?.completion_tokens ?? 0),
      latencyMs: Number(b?.extra_fields?.latency ?? Date.now() - started),
    };
    this.calls.push(use);
    return { data: parseJsonLoose(text), text, use };
  }

  async listLogs(q: LogListQuery = {}): Promise<{ logs: Record<string, any>[]; total: number }> {
    const p = new URLSearchParams();
    p.set("objects", "chat_completion");
    p.set("status", "success");
    p.set("sort_by", "timestamp");
    p.set("order", "desc");
    p.set("limit", String(q.limit ?? 50));
    p.set("offset", String(q.offset ?? 0));
    if (q.startTime) p.set("start_time", q.startTime);
    if (q.endTime) p.set("end_time", q.endTime);
    if (q.models?.length) p.set("models", q.models.join(","));
    if (q.virtualKeyIds?.length) p.set("virtual_key_ids", q.virtualKeyIds.join(","));
    const { status, body } = await this.request(`/api/logs?${p}`, { headers: this.adminHeaders() });
    if (status !== 200) throw new BifrostError(status, errorMessage(body, `GET /api/logs returned ${status}`));
    const b = body as Record<string, any>;
    return { logs: Array.isArray(b?.logs) ? b.logs : [], total: Number(b?.pagination?.total_count ?? 0) };
  }

  /** The list endpoint omits output_message; the detail endpoint includes it. */
  async getLog(id: string): Promise<Record<string, any>> {
    const { status, body } = await this.request(`/api/logs/${encodeURIComponent(id)}`, {
      headers: this.adminHeaders(),
    });
    if (status !== 200) throw new BifrostError(status, errorMessage(body, `GET /api/logs/${id} returned ${status}`));
    return body as Record<string, any>;
  }

  /**
   * Create a routing rule through the management API (POST /api/governance/routing-rules).
   * `id` is server-assigned, so only the documented request fields are sent.
   */
  async createRoutingRule(rule: {
    name: string;
    description?: string;
    cel_expression: string;
    targets: { provider: string; model: string; weight: number }[];
    enabled?: boolean;
    priority?: number;
    scope?: string;
  }): Promise<Record<string, any>> {
    const body = {
      name: rule.name,
      description: rule.description,
      cel_expression: rule.cel_expression,
      targets: rule.targets,
      enabled: rule.enabled ?? true,
      priority: rule.priority ?? 0,
      scope: rule.scope ?? "global",
    };
    const { status, body: res } = await this.request("/api/governance/routing-rules", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.adminHeaders() },
      body: JSON.stringify(body),
    });
    if (status < 200 || status >= 300) {
      throw new BifrostError(status, errorMessage(res, `POST /api/governance/routing-rules returned ${status}`));
    }
    return res as Record<string, any>;
  }

  /** Live usage of the auditor's virtual key (rate-limit counters and budgets). */
  async getVirtualKeyUsage(vkId: string): Promise<VirtualKeyUsage | null> {
    const { status, body } = await this.request(`/api/governance/virtual-keys/${encodeURIComponent(vkId)}`, {
      headers: this.adminHeaders(),
    });
    if (status !== 200) return null;
    const vk = (body as Record<string, any>)?.virtual_key ?? {};
    const rl = vk.rate_limit ?? null;
    return {
      id: vk.id ?? vkId,
      tokensUsed: rl?.token_current_usage ?? null,
      tokenLimit: rl?.token_max_limit ?? null,
      requestsUsed: rl?.request_current_usage ?? null,
      requestLimit: rl?.request_max_limit ?? null,
      budgets: (Array.isArray(vk.budgets) ? vk.budgets : []).map((x: Record<string, any>) => ({
        id: String(x.id),
        usedUsd: Number(x.current_usage ?? 0),
        limitUsd: Number(x.max_limit ?? 0),
        resetDuration: String(x.reset_duration ?? ""),
      })),
    };
  }
}
