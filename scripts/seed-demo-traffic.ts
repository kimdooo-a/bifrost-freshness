// Generates realistic "application" traffic through Bifrost so the auditor has
// logs to read: a few time-sensitive questions sent to the app's models with
// the demo app's virtual key (not the auditor's).
//   node scripts/seed-demo-traffic.ts [--models ollama/a,ollama/b]

import { existsSync } from "node:fs";
import { parseArgs } from "node:util";

if (existsSync(".env")) process.loadEnvFile(".env");
const { values } = parseArgs({ options: { models: { type: "string" } } });
const base = (process.env.BIFROST_URL ?? "http://localhost:8080").replace(/\/+$/, "");
const vk = process.env.DEMO_APP_VK;
const models = (values.models ?? "ollama/exaone-3.5-2.4b:latest,ollama/gemma4:e4b-it-q4km-chat").split(",");

export const QUESTIONS = [
  "Who is the current CEO of Intel? Answer in one or two sentences.",
  "What is the latest stable version of Python? Answer in one or two sentences.",
  "Who is the current Chancellor of Germany? Answer in one or two sentences.",
  "Who is the current Pope? Answer in one or two sentences.",
  "Who is the current CEO of Microsoft? Answer in one or two sentences.",
];

for (const model of models) {
  for (const q of QUESTIONS) {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(vk ? { "x-bf-vk": vk } : {}) },
      body: JSON.stringify({ model, messages: [{ role: "user", content: q }], temperature: 0, max_tokens: 200, reasoning_effort: "none" }),
    });
    const j: any = await res.json();
    const text = j?.choices?.[0]?.message?.content ?? JSON.stringify(j?.error ?? j);
    console.log(`[${model}] ${q}\n  -> ${String(text).replace(/\s+/g, " ").slice(0, 200)}`);
  }
}
