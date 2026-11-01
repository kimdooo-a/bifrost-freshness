import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BifrostClient, BifrostError, GovernanceLimitError } from "../src/bifrost.ts";
import { collectAnswers, logToAnswer } from "../src/logs.ts";
import { TavilyCapError, TavilyClient } from "../src/tavily.ts";
import { chatResponse, fakeFetch, tavilyResponse } from "./helpers.ts";

function client(fetchImpl: typeof fetch, extra: Partial<ConstructorParameters<typeof BifrostClient>[0]> = {}) {
  return new BifrostClient({
    baseUrl: "http://gw:8080",
    virtualKey: "sk-bf-test",
    adminUser: "admin",
    adminPassword: "pw",
    primaryModel: "ollama/big",
    fallbackModels: ["ollama/small"],
    fetchImpl,
    ...extra,
  });
}

test("chatJson sends the virtual key, fallback chain and JSON mode", async () => {
  const f = fakeFetch(() => ({ body: chatResponse({ claims: [] }, { model: "big" }) }));
  const c = client(f.fetch);
  const r = await c.chatJson([{ role: "user", content: "hi" }], "extract");
  const req = f.requests[0];
  assert.equal(req.url, "http://gw:8080/v1/chat/completions");
  assert.equal(req.headers["x-bf-vk"], "sk-bf-test");
  assert.equal(req.body.model, "ollama/big");
  assert.deepEqual(req.body.fallbacks, ["ollama/small"]);
  assert.deepEqual(req.body.response_format, { type: "json_object" });
  assert.deepEqual(r.data, { claims: [] });
  assert.equal(r.use.isFallback, false);
  assert.equal(r.use.served, "ollama/big");
});

test("chatJson reports when a fallback model took over", async () => {
  const f = fakeFetch(() => ({ body: chatResponse({ ok: 1 }, { model: "small", fallback: true, primary: "big" }) }));
  const c = client(f.fetch);
  const r = await c.chatJson([{ role: "user", content: "hi" }], "judge");
  assert.equal(r.use.isFallback, true);
  assert.equal(r.use.served, "ollama/small");
  assert.equal(r.use.requested, "ollama/big");
  assert.equal(c.calls.length, 1);
});

test("chatJson maps governance refusals (402 budget, 429 rate limit)", async () => {
  for (const [status, kind] of [
    [402, "budget"],
    [429, "rate_limit"],
  ] as const) {
    const f = fakeFetch(() => ({ status, body: { error: { message: "limit exceeded" } } }));
    await assert.rejects(client(f.fetch).chatJson([{ role: "user", content: "x" }], "judge"), (e: unknown) => {
      assert.ok(e instanceof GovernanceLimitError);
      assert.equal(e.kind, kind);
      assert.equal(e.message, "limit exceeded");
      return true;
    });
  }
  const f = fakeFetch(() => ({ status: 500, body: { error: { message: "boom" } } }));
  await assert.rejects(client(f.fetch).chatJson([{ role: "user", content: "x" }], "judge"), BifrostError);
});

test("listLogs uses documented query params and Basic auth; setup token as alternative", async () => {
  const f = fakeFetch(() => ({ body: { logs: [{ id: "a" }], pagination: { total_count: 1 } } }));
  const c = client(f.fetch);
  const r = await c.listLogs({ limit: 5, startTime: "2026-11-01T00:00:00.000Z", models: ["m1", "m2"] });
  const u = new URL(f.requests[0].url);
  assert.equal(u.pathname, "/api/logs");
  assert.equal(u.searchParams.get("objects"), "chat_completion");
  assert.equal(u.searchParams.get("status"), "success");
  assert.equal(u.searchParams.get("limit"), "5");
  assert.equal(u.searchParams.get("start_time"), "2026-11-01T00:00:00.000Z");
  assert.equal(u.searchParams.get("models"), "m1,m2");
  assert.equal(f.requests[0].headers.authorization, `Basic ${Buffer.from("admin:pw").toString("base64")}`);
  assert.equal(r.total, 1);

  const g = fakeFetch(() => ({ body: { logs: [] } }));
  await client(g.fetch, { adminUser: null, adminPassword: null, setupToken: "tok" }).listLogs();
  assert.equal(g.requests[0].headers["x-bifrost-setup-token"], "tok");
  const h = fakeFetch(() => ({ status: 401, body: { error: "unauthorized" } }));
  await assert.rejects(client(h.fetch).listLogs(), /unauthorized/);
});

test("getVirtualKeyUsage maps rate-limit counters and budgets", async () => {
  const f = fakeFetch(() => ({
    body: {
      virtual_key: {
        id: "vk-a",
        rate_limit: { token_current_usage: 44, token_max_limit: 1000, request_current_usage: 1, request_max_limit: 10 },
        budgets: [{ id: "b", current_usage: 0.25, max_limit: 1, reset_duration: "1d" }],
      },
    },
  }));
  const u = await client(f.fetch).getVirtualKeyUsage("vk-a");
  assert.deepEqual(u, {
    id: "vk-a",
    tokensUsed: 44,
    tokenLimit: 1000,
    requestsUsed: 1,
    requestLimit: 10,
    budgets: [{ id: "b", usedUsd: 0.25, limitUsd: 1, resetDuration: "1d" }],
  });
  assert.equal(new URL(f.requests[0].url).pathname, "/api/governance/virtual-keys/vk-a");
});

test("createRoutingRule posts only the documented fields with admin auth", async () => {
  const f = fakeFetch(() => ({ body: { message: "ok", rule: { id: "r-1" } } }));
  const r = await client(f.fetch).createRoutingRule({
    name: "n",
    cel_expression: 'model == "old"',
    targets: [{ provider: "ollama", model: "new", weight: 1 }],
    priority: 10,
  });
  assert.equal(r.rule.id, "r-1");
  const req = f.requests[0];
  assert.equal(new URL(req.url).pathname, "/api/governance/routing-rules");
  assert.equal(req.method, "POST");
  assert.ok(req.headers.authorization.startsWith("Basic "));
  assert.deepEqual(Object.keys(req.body).sort(), ["cel_expression", "enabled", "name", "priority", "scope", "targets"]);
  const bad = fakeFetch(() => ({ status: 400, body: { error: { message: "invalid CEL" } } }));
  await assert.rejects(client(bad.fetch).createRoutingRule({ name: "n", cel_expression: "(", targets: [] }), /invalid CEL/);
});

test("logToAnswer reads input_history and output_message (string or parts)", () => {
  const a = logToAnswer({
    id: "L1",
    provider: "ollama",
    model: "small",
    timestamp: "2026-11-01T00:00:00Z",
    virtual_key_name: "app",
    input_history: [
      { role: "system", content: "be brief" },
      { role: "user", content: [{ type: "text", text: "Who runs Intel?" }] },
    ],
    output_message: { role: "assistant", content: "Pat Gelsinger." },
  });
  assert.deepEqual(a, {
    source: { kind: "bifrost_log", logId: "L1", provider: "ollama", model: "ollama/small", timestamp: "2026-11-01T00:00:00Z", virtualKey: "app" },
    question: "Who runs Intel?",
    answer: "Pat Gelsinger.",
  });
  assert.equal(logToAnswer({ id: "L2", output_message: { content: "" } }), null);
});

test("collectAnswers skips the auditor's own virtual key and fetches details", async () => {
  const f = fakeFetch((req) => {
    const u = new URL(req.url);
    if (u.pathname === "/api/logs") {
      return {
        body: {
          logs: [
            { id: "1", status: "success", virtual_key_id: "vk-freshness-auditor" },
            { id: "2", status: "success", virtual_key_id: "vk-app" },
            { id: "3", status: "success", virtual_key_id: "vk-app", content_hidden: true },
          ],
        },
      };
    }
    return { body: { id: u.pathname.split("/").pop(), provider: "ollama", model: "m", output_message: { content: "answer" }, input_history: [] } };
  });
  const out = await collectAnswers(client(f.fetch), { limit: 10, excludeVirtualKeyId: "vk-freshness-auditor" });
  assert.equal(out.length, 1);
  assert.equal(out[0].source.logId, "2");
  assert.deepEqual(
    f.requests.map((r) => new URL(r.url).pathname),
    ["/api/logs", "/api/logs/2"],
  );
});

test("TavilyClient maps results, counts calls in a ledger and enforces the cap", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bf-fresh-"));
  const ledger = join(dir, "ledger.json");
  const f = fakeFetch(() => ({
    body: tavilyResponse([{ title: "T", url: "https://x.test/a", content: "C", published_date: "2026-10-01" }]),
  }));
  const t = new TavilyClient({ apiKey: "tvly-secret", maxCalls: 2, ledgerPath: ledger, fetchImpl: f.fetch });
  const s = await t.search("current CEO of Intel");
  assert.deepEqual(s, [{ n: 1, title: "T", url: "https://x.test/a", content: "C", score: 0.9, publishedDate: "2026-10-01" }]);
  assert.equal(f.requests[0].headers.authorization, "Bearer tvly-secret");
  assert.equal(f.requests[0].body.search_depth, "basic");
  await t.search("again");
  await assert.rejects(t.search("third"), TavilyCapError);
  assert.equal(f.requests.length, 2, "the capped call never reaches Tavily");
  assert.equal(JSON.parse(readFileSync(ledger, "utf8")).totalCalls, 2);
  assert.equal(t.remaining, 0);
});
