// Test doubles: a scripted fetch that records requests and returns canned
// Bifrost / Tavily responses.

export interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
}

export type Responder = (req: Recorded) => { status?: number; body: unknown } | Promise<{ status?: number; body: unknown }>;

export function fakeFetch(responder: Responder): { fetch: typeof fetch; requests: Recorded[] } {
  const requests: Recorded[] = [];
  const f = async (input: any, init: any = {}) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init.headers ?? {})) headers[k.toLowerCase()] = String(v);
    const rec: Recorded = {
      url: String(input),
      method: init.method ?? "GET",
      headers,
      body: init.body ? JSON.parse(init.body) : null,
    };
    requests.push(rec);
    const r = await responder(rec);
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), { status: r.status ?? 200 });
  };
  return { fetch: f as typeof fetch, requests };
}

/** A Bifrost chat completion response, optionally marked as served by a fallback. */
export function chatResponse(content: unknown, o: { model?: string; fallback?: boolean; primary?: string } = {}) {
  const model = o.model ?? "gemma4:26b-a4b-chat";
  return {
    choices: [{ index: 0, message: { role: "assistant", content: typeof content === "string" ? content : JSON.stringify(content) } }],
    model,
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    extra_fields: {
      request_type: "chat_completion",
      routing_info: {
        provider: "ollama",
        model,
        is_fallback: o.fallback === true,
        primary_provider: "ollama",
        primary_model: o.primary ?? model,
      },
      latency: 1234,
    },
  };
}

export function tavilyResponse(results: { title: string; url: string; content: string; published_date?: string }[]) {
  return { query: "q", results: results.map((r) => ({ score: 0.9, raw_content: null, ...r })), usage: { credits: 1 }, response_time: 0.5 };
}

export function isExtract(req: Recorded): boolean {
  return String(req.body?.messages?.[0]?.content ?? "").startsWith("You extract");
}
