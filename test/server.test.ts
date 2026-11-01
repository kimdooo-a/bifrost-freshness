import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { Runtime } from "../src/app.ts";
import { BifrostClient } from "../src/bifrost.ts";
import type { Settings } from "../src/config.ts";
import { createApiServer } from "../src/server.ts";
import { TavilyClient } from "../src/tavily.ts";
import { chatResponse, fakeFetch, isExtract, tavilyResponse } from "./helpers.ts";

test("HTTP API: POST /check validates input and returns a report", async () => {
  const b = fakeFetch((req) => {
    if (req.url.includes("/api/governance/")) return { status: 404, body: { error: "not found" } };
    if (isExtract(req)) {
      return { body: chatResponse({ claims: [{ text: "Jensen Huang is the CEO of Nvidia.", category: "office_holder", time_sensitive: true, sensitivity: "high", search_query: "Nvidia CEO" }] }) };
    }
    return { body: chatResponse({ verdict: "supported", confidence: 0.9, evidence: [{ source: 1, quote: "Jensen Huang is the CEO of Nvidia" }], inference: "still CEO" }) };
  });
  const t = fakeFetch(() => ({ body: tavilyResponse([{ title: "Nvidia", url: "https://n.test", content: "Jensen Huang is the CEO of Nvidia." }]) }));
  const settings = { bifrostUrl: "http://gw", virtualKeyId: "vk", primaryModel: "ollama/big", fallbackModels: [], today: "2026-11-02", tavilyLedger: null } as unknown as Settings;
  const rt: Runtime = {
    settings,
    bifrost: new BifrostClient({ baseUrl: "http://gw", virtualKey: "sk-bf-x", primaryModel: "ollama/big", fallbackModels: [], fetchImpl: b.fetch }),
    tavily: new TavilyClient({ apiKey: "k", maxCalls: 5, fetchImpl: t.fetch }),
  };
  const server = createApiServer(rt, 3, () => {});
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await fetch(`${base}/check`, { method: "POST", body: "{}" })).status, 400);
    assert.equal((await fetch(`${base}/nope`)).status, 404);
    const res = await fetch(`${base}/check`, { method: "POST", body: JSON.stringify({ answer: "Jensen Huang runs Nvidia." }) });
    assert.equal(res.status, 200);
    const report = await res.json();
    assert.equal(report.mode, "check");
    assert.equal(report.totals.supported, 1);
    assert.equal(report.audits[0].claims[0].evidence[0].url, "https://n.test");
    const html = await fetch(`${base}/check?format=html`, { method: "POST", body: JSON.stringify({ answer: "Jensen Huang runs Nvidia." }) });
    assert.match(await html.text(), /Bifrost Freshness Report/);
  } finally {
    server.close();
  }
});
