// Turn Bifrost log entries (GET /api/logs + GET /api/logs/{id}) into answers to audit.

import type { BifrostClient } from "./bifrost.ts";
import type { AnswerSource } from "./types.ts";

export interface LoggedAnswer {
  source: AnswerSource;
  question: string | null;
  answer: string;
}

/** Message content may be a string or an array of content parts. */
export function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === "object" && typeof (p as any).text === "string" ? (p as any).text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/** Maps one detailed log entry to an answer. Returns null if there is nothing to audit. Pure. */
export function logToAnswer(log: Record<string, any>): LoggedAnswer | null {
  const answer = contentToText(log?.output_message?.content).trim();
  if (!answer) return null;
  const history: any[] = Array.isArray(log?.input_history) ? log.input_history : [];
  const lastUser = [...history].reverse().find((m) => m?.role === "user");
  const provider = typeof log.provider === "string" ? log.provider : undefined;
  const model = typeof log.model === "string" ? log.model : undefined;
  return {
    source: {
      kind: "bifrost_log",
      logId: String(log.id),
      provider,
      model: provider && model ? `${provider}/${model}` : model,
      timestamp: typeof log.timestamp === "string" ? log.timestamp : undefined,
      virtualKey: log.virtual_key_name ?? log.virtual_key_id ?? null,
    },
    question: lastUser ? contentToText(lastUser.content).trim() || null : null,
    answer,
  };
}

export interface CollectOptions {
  limit: number;
  since?: string;
  models?: string[];
  /** The auditor's own virtual key: its traffic is never audited. */
  excludeVirtualKeyId?: string | null;
}

export async function collectAnswers(bifrost: BifrostClient, o: CollectOptions): Promise<LoggedAnswer[]> {
  const out: LoggedAnswer[] = [];
  let offset = 0;
  const page = 50;
  while (out.length < o.limit) {
    const { logs } = await bifrost.listLogs({ limit: page, offset, startTime: o.since, models: o.models });
    if (logs.length === 0) break;
    for (const entry of logs) {
      if (out.length >= o.limit) break;
      if (o.excludeVirtualKeyId && entry.virtual_key_id === o.excludeVirtualKeyId) continue;
      if (entry.status !== "success" || entry.content_hidden) continue;
      const detail = await bifrost.getLog(String(entry.id));
      const a = logToAnswer(detail);
      if (a) out.push(a);
    }
    if (logs.length < page) break;
    offset += page;
  }
  return out;
}
