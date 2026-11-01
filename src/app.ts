// Wires settings -> clients -> pipeline -> report. Shared by the CLI and the HTTP server.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BifrostClient, type VirtualKeyUsage } from "./bifrost.ts";
import type { Settings } from "./config.ts";
import { renderHtml } from "./html.ts";
import { collectAnswers } from "./logs.ts";
import { auditAnswer, RunState, type PipelineDeps } from "./pipeline.ts";
import { summarizeCalls, suggestRoutingRules, tallyAudits, type FreshnessReport } from "./report.ts";
import { TavilyClient } from "./tavily.ts";
import type { AnswerAudit } from "./types.ts";

export interface Runtime {
  settings: Settings;
  bifrost: BifrostClient;
  tavily: TavilyClient;
}

export function createRuntime(settings: Settings): Runtime {
  if (!settings.tavilyKey) {
    throw new Error("No Tavily key: set TAVILY_API_KEY or TAVILY_API_KEY_FILE (see .env.example)");
  }
  const bifrost = new BifrostClient({
    baseUrl: settings.bifrostUrl,
    virtualKey: settings.virtualKey,
    adminUser: settings.adminUser,
    adminPassword: settings.adminPassword,
    setupToken: settings.setupToken,
    primaryModel: settings.primaryModel,
    fallbackModels: settings.fallbackModels,
    timeoutMs: settings.requestTimeoutMs,
  });
  const tavily = new TavilyClient({
    apiKey: settings.tavilyKey,
    maxCalls: settings.tavilyMaxCalls,
    ledgerPath: settings.tavilyLedger,
  });
  return { settings, bifrost, tavily };
}

export async function vkUsage(rt: Runtime): Promise<VirtualKeyUsage | null> {
  if (!rt.settings.virtualKeyId) return null;
  try {
    return await rt.bifrost.getVirtualKeyUsage(rt.settings.virtualKeyId);
  } catch {
    return null;
  }
}

export function buildReport(
  rt: Runtime,
  mode: FreshnessReport["mode"],
  audits: AnswerAudit[],
  state: RunState,
  vkBefore: VirtualKeyUsage | null,
  vkAfter: VirtualKeyUsage | null,
): FreshnessReport {
  const { totals, byModel, byCategory } = tallyAudits(audits);
  const calls = summarizeCalls(rt.bifrost.calls);
  return {
    generatedAt: new Date().toISOString(),
    today: rt.settings.today,
    mode,
    gateway: { baseUrl: rt.settings.bifrostUrl, vkBefore, vkAfter },
    auditor: {
      primaryModel: rt.settings.primaryModel,
      fallbackModels: rt.settings.fallbackModels,
      ...calls,
      stoppedEarly: state.stopped?.message ?? null,
    },
    tavily: {
      callsThisRun: rt.tavily.callsThisRun,
      creditsThisRun: rt.tavily.creditsThisRun,
      ledgerTotalCalls: rt.settings.tavilyLedger ? rt.tavily.ledger().totalCalls : null,
    },
    totals,
    byModel,
    byCategory,
    routingSuggestions: suggestRoutingRules(byModel),
    audits,
  };
}

export function writeReport(report: FreshnessReport, outDir: string, name: string): { json: string; html: string } {
  mkdirSync(outDir, { recursive: true });
  const json = join(outDir, `${name}.json`);
  const html = join(outDir, `${name}.html`);
  writeFileSync(json, JSON.stringify(report, null, 2) + "\n");
  writeFileSync(html, renderHtml(report));
  return { json, html };
}

export interface AuditLogsOptions {
  limit: number;
  since?: string;
  models?: string[];
  maxClaims: number;
  log: (m: string) => void;
}

/** Audit recent answers recorded in Bifrost's log store. */
export async function auditLogs(rt: Runtime, o: AuditLogsOptions): Promise<FreshnessReport> {
  const vkBefore = await vkUsage(rt);
  const answers = await collectAnswers(rt.bifrost, {
    limit: o.limit,
    since: o.since,
    models: o.models,
    excludeVirtualKeyId: rt.settings.virtualKeyId,
  });
  o.log(`Found ${answers.length} answer(s) in Bifrost logs to audit.`);
  const deps: PipelineDeps = { bifrost: rt.bifrost, tavily: rt.tavily, today: rt.settings.today, maxClaims: o.maxClaims, log: o.log };
  const state = new RunState();
  const audits: AnswerAudit[] = [];
  for (const [i, a] of answers.entries()) {
    o.log(`[${i + 1}/${answers.length}] ${a.source.model} log ${a.source.logId}`);
    audits.push(await auditAnswer(a, deps, state));
  }
  return buildReport(rt, "logs", audits, state, vkBefore, await vkUsage(rt));
}

/** Audit one answer supplied directly (CLI `check` or HTTP POST /check). */
export async function checkAnswer(
  rt: Runtime,
  input: { answer: string; question?: string | null; model?: string | null },
  o: { maxClaims: number; log: (m: string) => void },
): Promise<FreshnessReport> {
  const vkBefore = await vkUsage(rt);
  const state = new RunState();
  const deps: PipelineDeps = { bifrost: rt.bifrost, tavily: rt.tavily, today: rt.settings.today, maxClaims: o.maxClaims, log: o.log };
  const audit = await auditAnswer(
    { source: { kind: "direct", model: input.model ?? undefined }, question: input.question ?? null, answer: input.answer },
    deps,
    state,
  );
  return buildReport(rt, "check", [audit], state, vkBefore, await vkUsage(rt));
}
