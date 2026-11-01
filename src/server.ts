// Minimal HTTP API: POST /check {"answer": "...", "question"?: "...", "model"?: "..."}
// returns the FreshnessReport JSON for that single answer. Requests are
// processed one at a time because the local LLM is the bottleneck.

import { createServer, type IncomingMessage, type Server } from "node:http";
import { checkAnswer, type Runtime } from "./app.ts";
import { renderHtml } from "./html.ts";

const MAX_BODY = 200_000;

async function readBody(req: IncomingMessage): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function createApiServer(rt: Runtime, maxClaims: number, log: (m: string) => void): Server {
  let queue: Promise<unknown> = Promise.resolve();
  return createServer(async (req, res) => {
    const send = (status: number, body: unknown, type = "application/json") => {
      res.writeHead(status, { "Content-Type": `${type}; charset=utf-8` });
      res.end(type === "application/json" ? JSON.stringify(body, null, 2) : String(body));
    };
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/health") return send(200, { status: "ok" });
      if (req.method === "POST" && url.pathname === "/check") {
        const parsed = JSON.parse((await readBody(req)) || "{}");
        if (typeof parsed.answer !== "string" || parsed.answer.trim() === "") {
          return send(400, { error: "body must be JSON with a non-empty string field `answer`" });
        }
        const job = queue.then(() =>
          checkAnswer(rt, { answer: parsed.answer, question: parsed.question ?? null, model: parsed.model ?? null }, { maxClaims, log }),
        );
        queue = job.catch(() => undefined);
        const report = await job;
        if (url.searchParams.get("format") === "html") return send(200, renderHtml(report), "text/html");
        return send(200, report);
      }
      return send(404, { error: "not found. Use POST /check or GET /health" });
    } catch (e) {
      return send(500, { error: (e as Error).message });
    }
  });
}
