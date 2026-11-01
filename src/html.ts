// Static, dependency-free HTML dashboard for a FreshnessReport.

import type { FreshnessReport, Tally } from "./report.ts";
import type { ClaimResult } from "./types.ts";

export function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeUrl(u: string): string {
  return /^https?:\/\//i.test(u) ? esc(u) : "#";
}

function hostOf(u: string): string {
  try {
    return new URL(u).hostname;
  } catch {
    return "source";
  }
}

function pct(r: number | null): string {
  return r === null ? "n/a" : `${Math.round(r * 100)}%`;
}

function tallyRows(rec: Record<string, Tally>): string {
  const rows = Object.entries(rec).sort((a, b) => (b[1].stalenessRate ?? -1) - (a[1].stalenessRate ?? -1));
  if (rows.length === 0) return `<tr><td colspan="7" class="muted">no data</td></tr>`;
  return rows
    .map(
      ([k, t]) => `<tr><td><code>${esc(k)}</code></td><td>${t.answers || "-"}</td><td>${t.checked}</td>
<td class="v-supported">${t.supported}</td><td class="v-changed">${t.changed}</td><td class="v-unverifiable">${t.unverifiable}</td>
<td><div class="bar"><span style="width:${Math.round((t.stalenessRate ?? 0) * 100)}%"></span></div>${pct(t.stalenessRate)}</td></tr>`,
    )
    .join("\n");
}

function claimCard(c: ClaimResult): string {
  const score = c.freshness.score === null ? "?" : String(c.freshness.score);
  const status = c.skipped ? `skipped: ${c.skipped.replace(/_/g, " ")}` : c.verdict;
  const cls = c.skipped ? "skipped" : c.verdict;
  const evidence = c.evidence.length
    ? `<ul class="evidence">${c.evidence
        .map(
          (e) =>
            `<li><q>${esc(e.quote)}</q> <a href="${safeUrl(e.url)}" target="_blank" rel="noopener">[${e.source}] ${esc(hostOf(e.url))}</a>${e.match === "near" ? ' <span class="muted">(near-verbatim)</span>' : ""}</li>`,
        )
        .join("")}</ul>`
    : `<p class="muted">No verbatim evidence.</p>`;
  const sources = c.sources.length
    ? `<details><summary>${c.sources.length} source(s) searched</summary><ol>${c.sources
        .map((s) => `<li><a href="${safeUrl(s.url)}" target="_blank" rel="noopener">${esc(s.title || s.url)}</a>${s.publishedDate ? ` <span class="muted">${esc(s.publishedDate)}</span>` : ""}</li>`)
        .join("")}</ol></details>`
    : "";
  const body = c.skipped === "not_time_sensitive"
    ? ""
    : `<div class="cols"><div><h5>Evidence <span class="muted">(text found in sources)</span></h5>${evidence}</div>
<div><h5>Inference <span class="muted">(model reasoning, not evidence)</span></h5><p>${esc(c.inference) || '<span class="muted">-</span>'}</p>
${c.currentValue ? `<p><b>Current value:</b> ${esc(c.currentValue)}</p>` : ""}</div></div>${sources}
${c.notes.length ? `<p class="notes">${c.notes.map(esc).join("<br>")}</p>` : ""}
${c.judge ? `<p class="muted small">judged by <code>${esc(c.judge.served)}</code>${c.judge.isFallback ? " <b class='warn'>(fallback took over)</b>" : ""}</p>` : ""}`;
  return `<div class="claim ${cls}"><div class="head"><span class="badge ${cls}">${esc(status)}</span>
<span class="fresh" title="freshness score 0 (stale) - 100 (current)">freshness ${score} &middot; ${esc(c.freshness.confidence)} confidence</span>
<span class="cat">${esc(c.claim.category)}</span></div><p class="ctext">${esc(c.claim.text)}</p>${body}</div>`;
}

export function renderHtml(r: FreshnessReport): string {
  const a = r.auditor;
  const vk = r.gateway.vkAfter;
  const served = Object.entries(a.servedBy).map(([m, n]) => `<code>${esc(m)}</code> &times; ${n}`).join(", ") || "-";
  const audits = r.audits
    .map(
      (au, i) => `<section class="answer"><h3>#${i + 1} ${esc(au.source.model ?? "direct input")}
${au.source.logId ? `<span class="muted small">log ${esc(au.source.logId)} &middot; ${esc(au.source.timestamp ?? "")}</span>` : ""}</h3>
${au.question ? `<p class="q"><b>Q:</b> ${esc(au.question)}</p>` : ""}
<details><summary>Answer text</summary><pre>${esc(au.answer)}</pre></details>
${au.error ? `<p class="warn">${esc(au.error)}</p>` : ""}
${au.claims.map(claimCard).join("\n")}</section>`,
    )
    .join("\n");
  const rules = r.routingSuggestions.length
    ? `<pre>${esc(JSON.stringify({ governance: { routing_rules: r.routingSuggestions } }, null, 2))}</pre>`
    : `<p class="muted">No rule suggested (needs at least two audited models with decided claims and a staleness gap).</p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bifrost Freshness Report</title><style>
:root{--ok:#1a7f37;--bad:#cf222e;--unk:#8250df;--mut:#57606a;--line:#d0d7de}
body{font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;margin:0;color:#1f2328;background:#f6f8fa}
main{max-width:1100px;margin:0 auto;padding:24px}h1{margin:0 0 4px}h2{margin-top:32px;border-bottom:1px solid var(--line)}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin:16px 0}
.card{background:#fff;border:1px solid var(--line);border-radius:8px;padding:12px}.card b{display:block;font-size:24px}
table{border-collapse:collapse;width:100%;background:#fff}td,th{border:1px solid var(--line);padding:6px 8px;text-align:left}
.bar{display:inline-block;width:80px;height:8px;background:#eee;margin-right:6px;vertical-align:middle}.bar span{display:block;height:100%;background:var(--bad)}
.v-supported{color:var(--ok)}.v-changed{color:var(--bad)}.v-unverifiable{color:var(--unk)}
.answer{background:#fff;border:1px solid var(--line);border-radius:8px;padding:12px 16px;margin:16px 0}
.claim{border-left:4px solid var(--line);padding:6px 12px;margin:10px 0}.claim.supported{border-color:var(--ok)}.claim.changed{border-color:var(--bad)}.claim.unverifiable{border-color:var(--unk)}
.badge{color:#fff;border-radius:10px;padding:1px 8px;font-size:12px;background:var(--mut)}.badge.supported{background:var(--ok)}.badge.changed{background:var(--bad)}.badge.unverifiable{background:var(--unk)}
.fresh,.cat{margin-left:8px;color:var(--mut);font-size:12px}.ctext{font-weight:600;margin:6px 0}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:16px}.cols h5{margin:4px 0}.evidence q{background:#fff8c5}
.muted{color:var(--mut)}.small{font-size:12px}.warn{color:var(--bad)}.notes{font-size:12px;color:#9a6700}
pre{white-space:pre-wrap;background:#f6f8fa;padding:8px;border-radius:6px;overflow:auto}
@media(max-width:700px){.cols{grid-template-columns:1fr}}
</style></head><body><main>
<h1>Bifrost Freshness Report</h1>
<p class="muted">Generated ${esc(r.generatedAt)} &middot; reference date ${esc(r.today)} &middot; mode <code>${esc(r.mode)}</code> &middot; gateway <code>${esc(r.gateway.baseUrl)}</code></p>
<div class="cards">
<div class="card"><b>${r.totals.answers}</b>answers audited</div>
<div class="card"><b>${r.totals.checked}</b>claims researched</div>
<div class="card"><b class="v-changed">${r.totals.changed}</b>changed (stale)</div>
<div class="card"><b class="v-supported">${r.totals.supported}</b>still supported</div>
<div class="card"><b class="v-unverifiable">${r.totals.unverifiable}</b>unverifiable</div>
<div class="card"><b>${pct(r.totals.stalenessRate)}</b>staleness rate</div>
</div>
<h2>Staleness by audited model</h2>
<table><tr><th>model</th><th>answers</th><th>researched</th><th>supported</th><th>changed</th><th>unverifiable</th><th>staleness</th></tr>${tallyRows(r.byModel)}</table>
<h2>Staleness by topic</h2>
<table><tr><th>category</th><th>answers</th><th>researched</th><th>supported</th><th>changed</th><th>unverifiable</th><th>staleness</th></tr>${tallyRows(r.byCategory)}</table>
<h2>Suggested Bifrost routing rules</h2>${rules}
<h2>Auditor run (through Bifrost)</h2>
<ul>
<li>Primary model <code>${esc(a.primaryModel)}</code>, fallbacks ${a.fallbackModels.map((m) => `<code>${esc(m)}</code>`).join(", ") || "none"}</li>
<li>${a.calls} LLM calls served by ${served}; <b class="${a.fallbackCalls ? "warn" : ""}">${a.fallbackCalls} answered by a fallback model</b></li>
<li>Tokens: ${a.promptTokens} prompt + ${a.completionTokens} completion</li>
${vk ? `<li>Virtual key <code>${esc(vk.id)}</code>: ${vk.tokensUsed ?? "?"} / ${vk.tokenLimit ?? "?"} tokens, ${vk.requestsUsed ?? "?"} / ${vk.requestLimit ?? "?"} requests in window${vk.budgets.map((b) => `; budget ${esc(b.id)} $${b.usedUsd.toFixed(4)} / $${b.limitUsd} per ${esc(b.resetDuration)}`).join("")}</li>` : ""}
<li>Tavily: ${r.tavily.callsThisRun} searches this run${r.tavily.ledgerTotalCalls !== null ? ` (${r.tavily.ledgerTotalCalls} total in ledger)` : ""}</li>
${a.stoppedEarly ? `<li class="warn">Stopped early: ${esc(a.stoppedEarly)}</li>` : ""}
</ul>
<h2>Claims</h2>
${audits}
</main></body></html>
`;
}
