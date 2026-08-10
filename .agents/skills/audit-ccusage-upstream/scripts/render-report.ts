#!/usr/bin/env bun
/** Render a self-contained dark HTML ccusage upstream audit from evidence JSON. */

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

type JsonObject = Record<string, unknown>;
type Column = readonly [key: string, label: string];

const ALLOWED_LEVELS = new Set(["none", "low", "medium", "high", "unknown"]);
const ALLOWED_STATUSES = new Set(["current", "behind", "ahead", "diverged", "unknown"]);

function asObject(value: unknown, label = "value"): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`Expected object: ${label}`);
  }
  return value as JsonObject;
}

function getArray(object: JsonObject, key: string): unknown[] {
  const value = get(object, key, []);
  return Array.isArray(value) ? value : [];
}

function get(object: JsonObject, key: string, fallback?: unknown): unknown {
  return Object.hasOwn(object, key) ? object[key] : fallback;
}

function scalarString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value === true) return "True";
  if (value === false) return "False";
  return String(value);
}

function esc(value: unknown): string {
  return scalarString(value).replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#x27;";
    }
  });
}

function link(value: unknown): string {
  const item = asObject(value, "source");
  const label = esc(item.label || item.url || "Source");
  const url = esc(get(item, "url", ""));
  const note = item.note ? `<span class="source-note">${esc(item.note)}</span>` : "";
  return `<a href="${url}" target="_blank" rel="noreferrer">${label}<span aria-hidden="true">↗</span></a>${note}`;
}

function pills(items: unknown[], kind = "plain"): string {
  return items.map((item) => `<span class="pill ${esc(kind)}">${esc(item)}</span>`).join("");
}

function evidenceLinks(items: unknown[]): string {
  if (items.length === 0) return '<span class="muted">No direct link recorded</span>';
  return `<div class="evidence">${items.map(link).join("")}</div>`;
}

function workList(items: unknown[]): string {
  if (items.length === 0) return '<p class="muted">No additional work identified.</p>';
  return `<ul>${items.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>`;
}

function changeCards(items: unknown[], empty: string): string {
  if (items.length === 0) return `<div class="empty">${esc(empty)}</div>`;
  const cards = items.map((value) => {
    const item = asObject(value, "change");
    const level = scalarString(get(item, "complexity", "unknown")).toLowerCase();
    const affected = getArray(item, "affected_files").map(scalarString);
    const meta = [item.version, item.date, item.category].filter(Boolean);
    return `<article class="card change-card">
          <div class="card-head"><div>${pills(meta)}<h3>${esc(get(item, "title", "Untitled change"))}</h3></div><span class="badge ${esc(level)}">${esc(level)}</span></div>
          <p>${esc(get(item, "summary", ""))}</p>
          <div class="callout"><strong>Observatory impact</strong><p>${esc(get(item, "impact", "Not established."))}</p></div>
          <h4>Required work</h4>${workList(getArray(item, "required_work"))}
          ${affected.length > 0 ? `<div class="files">${pills(affected, "file")}</div>` : ""}
          ${evidenceLinks(getArray(item, "evidence"))}
        </article>`;
  });
  return `<div class="card-grid">${cards.join("")}</div>`;
}

function opportunityCards(items: unknown[]): string {
  if (items.length === 0) return '<div class="empty">No new upstream opportunities were established.</div>';
  const cards = items.map((value) => {
    const item = asObject(value, "opportunity");
    const effort = scalarString(get(item, "effort", "unknown")).toLowerCase();
    const recommendation = scalarString(get(item, "recommendation", "watch")).toLowerCase();
    return `<article class="card">
          <div class="card-head"><div><span class="eyebrow">${esc(recommendation)}</span><h3>${esc(get(item, "title", "Untitled opportunity"))}</h3></div><span class="badge ${esc(effort)}">${esc(effort)} effort</span></div>
          <p>${esc(get(item, "value", ""))}</p>
          <div class="callout"><strong>Architecture fit</strong><p>${esc(get(item, "fit", "Not assessed."))}</p></div>
          <h4>Work outline</h4>${workList(getArray(item, "required_work"))}
          ${evidenceLinks(getArray(item, "evidence"))}
        </article>`;
  });
  return `<div class="card-grid">${cards.join("")}</div>`;
}

function rows(items: unknown[], columns: Column[]): string {
  if (items.length === 0) return `<tr><td colspan="${columns.length}" class="muted">None recorded.</td></tr>`;
  return items
    .map((value) => {
      const item = asObject(value, "table row");
      return `<tr>${columns.map(([key]) => `<td>${esc(get(item, key, "—"))}</td>`).join("")}</tr>`;
    })
    .join("");
}

export function validate(data: JsonObject): void {
  for (const key of ["metadata", "versions", "assessment"]) {
    asObject(data[key], key);
  }
  const versions = asObject(data.versions, "versions");
  const assessment = asObject(data.assessment, "assessment");
  const status = scalarString(get(versions, "status", "unknown")).toLowerCase();
  const level = scalarString(get(assessment, "complexity", "unknown")).toLowerCase();
  if (!ALLOWED_STATUSES.has(status)) throw new Error(`Invalid versions.status: ${status}`);
  if (!ALLOWED_LEVELS.has(level)) throw new Error(`Invalid assessment.complexity: ${level}`);
  for (const key of [
    "sources",
    "released_changes",
    "unreleased_changes",
    "opportunities",
    "issues",
    "local_surface",
    "validation",
    "limitations",
  ]) {
    if (key in data && !Array.isArray(data[key])) throw new TypeError(`Expected array: ${key}`);
  }
}

const STYLES = `:root{--bg:#080b10;--panel:#10151d;--panel2:#151c26;--line:#263140;--text:#eef3f8;--muted:#98a7b8;--cyan:#5ee7f2;--green:#6ee7a8;--amber:#f7c66b;--red:#ff7d8c;--purple:#b9a2ff;--shadow:0 24px 70px rgba(0,0,0,.32)}
*{box-sizing:border-box}html{color-scheme:dark;scroll-behavior:smooth}body{margin:0;background:radial-gradient(circle at 16% -10%,#163445 0,transparent 32rem),radial-gradient(circle at 90% 0,#251c45 0,transparent 28rem),var(--bg);color:var(--text);font:15px/1.6 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}a{color:var(--cyan);text-decoration:none}a:hover{text-decoration:underline}.shell{width:min(1180px,calc(100% - 32px));margin:auto;padding:42px 0 80px}header{padding:40px;border:1px solid var(--line);border-radius:24px;background:linear-gradient(135deg,rgba(18,29,39,.96),rgba(14,17,27,.92));box-shadow:var(--shadow);position:relative;overflow:hidden}header:after{content:"";position:absolute;width:240px;height:240px;border:1px solid rgba(94,231,242,.18);border-radius:50%;right:-75px;top:-125px;box-shadow:0 0 70px rgba(94,231,242,.12)}.eyebrow{color:var(--cyan);font-size:.72rem;font-weight:800;letter-spacing:.14em;text-transform:uppercase}h1{font-size:clamp(2rem,6vw,4.25rem);line-height:1;margin:.35rem 0 1rem;letter-spacing:-.045em;max-width:800px}h2{font-size:1.6rem;letter-spacing:-.025em;margin:0}h3{font-size:1.08rem;line-height:1.3;margin:.45rem 0}h4{margin:1.2rem 0 .25rem;font-size:.78rem;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}p{margin:.4rem 0 1rem}.lede{font-size:1.08rem;color:#c4d0dc;max-width:820px}.hero-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-top:30px}.metric{padding:16px;border:1px solid var(--line);border-radius:14px;background:rgba(8,11,16,.46)}.metric span{display:block;color:var(--muted);font-size:.72rem;text-transform:uppercase;letter-spacing:.08em}.metric strong{display:block;font-size:1.25rem;margin-top:4px;overflow-wrap:anywhere}.badge,.pill{display:inline-flex;align-items:center;border:1px solid var(--line);background:#18212c;border-radius:999px;padding:4px 9px;font-size:.72rem;font-weight:750;text-transform:uppercase;letter-spacing:.05em;white-space:nowrap}.badge.none,.badge.low,.badge.current{color:var(--green);border-color:rgba(110,231,168,.35);background:rgba(110,231,168,.09)}.badge.medium,.badge.behind{color:var(--amber);border-color:rgba(247,198,107,.35);background:rgba(247,198,107,.09)}.badge.high,.badge.failed{color:var(--red);border-color:rgba(255,125,140,.35);background:rgba(255,125,140,.09)}.badge.unknown{color:var(--purple)}nav{display:flex;gap:8px;flex-wrap:wrap;padding:18px 0}nav a{color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:7px 12px;background:rgba(16,21,29,.75)}section{padding:32px 0;border-top:1px solid rgba(38,49,64,.75)}.section-head{display:flex;align-items:end;justify-content:space-between;gap:24px;margin-bottom:18px}.section-head p{color:var(--muted);margin:0;max-width:600px}.summary{padding:24px;border:1px solid rgba(94,231,242,.3);background:rgba(94,231,242,.06);border-radius:18px}.summary strong{color:var(--cyan)}.card-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.card{border:1px solid var(--line);background:linear-gradient(150deg,var(--panel2),var(--panel));border-radius:18px;padding:22px;box-shadow:0 14px 40px rgba(0,0,0,.16)}.card-head{display:flex;align-items:start;justify-content:space-between;gap:18px}.card-head .pill{margin-right:6px}.card p{color:#bbc7d4}.callout{border-left:2px solid var(--purple);padding:4px 0 4px 14px;margin:18px 0}.callout p{margin:3px 0}ul{padding-left:20px}.files,.evidence{display:flex;gap:7px;flex-wrap:wrap;margin-top:16px}.pill.file{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:none;letter-spacing:0;color:#b9c8d8}.evidence a{display:inline-flex;gap:5px;align-items:center;border-bottom:1px dotted rgba(94,231,242,.55)}.source-note{display:block;color:var(--muted);font-size:.8rem}.source-list,.issue-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;list-style:none;padding:0}.source-list li,.issue-list li{padding:16px;border:1px solid var(--line);border-radius:14px;background:var(--panel)}.issue-list .pill{margin-left:8px}.issue-list p{color:var(--muted);margin:.5rem 0 0}.table-wrap{overflow:auto;border:1px solid var(--line);border-radius:16px}table{border-collapse:collapse;width:100%;min-width:700px;background:var(--panel)}th,td{padding:13px 15px;text-align:left;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-size:.72rem;text-transform:uppercase;letter-spacing:.07em;background:#151c25}tr:last-child td{border-bottom:0}.empty{border:1px dashed var(--line);color:var(--muted);padding:24px;border-radius:16px;text-align:center}.muted{color:var(--muted)}footer{color:var(--muted);font-size:.82rem;padding-top:24px}@media(max-width:760px){header{padding:25px}.hero-grid{grid-template-columns:repeat(2,1fr)}.card-grid,.source-list,.issue-list{grid-template-columns:1fr}.section-head{display:block}}@media print{body{background:#fff;color:#111}.shell{width:100%;padding:0}header,.card,table,.source-list li,.issue-list li{box-shadow:none;background:#fff;color:#111}nav{display:none}}`;

export function render(data: JsonObject): string {
  validate(data);
  const meta = asObject(data.metadata, "metadata");
  const versions = asObject(data.versions, "versions");
  const assessment = asObject(data.assessment, "assessment");
  const status = scalarString(get(versions, "status", "unknown")).toLowerCase();
  const complexity = scalarString(get(assessment, "complexity", "unknown")).toLowerCase();
  const sources = getArray(data, "sources");
  const issueItems = getArray(data, "issues");
  const issueHtml =
    issueItems
      .map((value) => {
        const item = asObject(value, "issue");
        return `<li><a href="${esc(get(item, "url", ""))}" target="_blank" rel="noreferrer">#${esc(get(item, "number", "—"))} ${esc(get(item, "title", "Untitled issue"))}</a><span class="pill">${esc(get(item, "state", "unknown"))}</span><p>${esc(get(item, "relevance", ""))}</p></li>`;
      })
      .join("") || '<li class="muted">No directly relevant issues were recorded.</li>';
  const sourceHtml = sources.map((item) => `<li>${link(item)}</li>`).join("") || '<li class="muted">No sources recorded.</li>';
  const limitations = workList(getArray(data, "limitations"));
  const surfaceColumns: Column[] = [
    ["path", "Path"],
    ["role", "Role"],
    ["risk", "Risk"],
    ["notes", "Notes"],
  ];
  const validationColumns: Column[] = [
    ["check", "Check"],
    ["status", "Status"],
    ["notes", "Notes"],
  ];
  const title = esc(get(meta, "title", "ccusage upstream audit"));
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
${STYLES}
</style></head><body><main class="shell">
<header><span class="eyebrow">Upstream dependency intelligence</span><h1>${title}</h1><p class="lede">${esc(get(assessment, "summary", ""))}</p>
<div class="hero-grid"><div class="metric"><span>Pinned</span><strong>${esc(get(versions, "pinned", "unknown"))}</strong></div><div class="metric"><span>Latest stable</span><strong>${esc(get(versions, "latest_stable", "unknown"))}</strong></div><div class="metric"><span>Status</span><strong><span class="badge ${esc(status)}">${esc(status)}</span></strong></div><div class="metric"><span>Upgrade complexity</span><strong><span class="badge ${esc(complexity)}">${esc(complexity)}</span></strong></div></div></header>
<nav><a href="#assessment">Assessment</a><a href="#released">Released</a><a href="#unreleased">Unreleased</a><a href="#opportunities">Opportunities</a><a href="#issues">Issues</a><a href="#surface">Local surface</a><a href="#sources">Sources</a></nav>
<section id="assessment"><div class="section-head"><div><span class="eyebrow">Decision</span><h2>Upgrade assessment</h2></div><p>Generated ${esc(get(meta, "generated_at", "unknown time"))}</p></div><div class="summary"><strong>Recommendation</strong><p>${esc(get(assessment, "recommendation", "No recommendation recorded."))}</p><span class="muted">Resolved ${esc(get(versions, "resolved", "unknown"))} · installed ${esc(get(versions, "installed", "unknown"))} · ${esc(get(versions, "released_versions_behind", "unknown"))} released version(s) behind</span></div></section>
<section id="released"><div class="section-head"><div><span class="eyebrow">Stable releases</span><h2>Released changes</h2></div><p>Changes between the project pin and the latest stable package.</p></div>${changeCards(getArray(data, "released_changes"), "No released changes exist between the pin and latest stable version.")}</section>
<section id="unreleased"><div class="section-head"><div><span class="eyebrow">Default branch</span><h2>Unreleased upstream work</h2></div><p>Not part of the latest stable package; do not treat these as upgrade requirements.</p></div>${changeCards(getArray(data, "unreleased_changes"), "No relevant unreleased changes were established.")}</section>
<section id="opportunities"><div class="section-head"><div><span class="eyebrow">Product fit</span><h2>Observatory opportunities</h2></div><p>Optional capabilities assessed independently from upgrade necessity.</p></div>${opportunityCards(getArray(data, "opportunities"))}</section>
<section id="issues"><div class="section-head"><div><span class="eyebrow">Watch list</span><h2>Relevant upstream issues</h2></div></div><ul class="issue-list">${issueHtml}</ul></section>
<section id="surface"><div class="section-head"><div><span class="eyebrow">Compatibility boundary</span><h2>Local integration surface</h2></div></div><div class="table-wrap"><table><thead><tr>${surfaceColumns.map(([, label]) => `<th>${esc(label)}</th>`).join("")}</tr></thead><tbody>${rows(getArray(data, "local_surface"), surfaceColumns)}</tbody></table></div></section>
<section id="validation"><div class="section-head"><div><span class="eyebrow">Confidence</span><h2>Validation performed</h2></div></div><div class="table-wrap"><table><thead><tr>${validationColumns.map(([, label]) => `<th>${esc(label)}</th>`).join("")}</tr></thead><tbody>${rows(getArray(data, "validation"), validationColumns)}</tbody></table></div><h4>Limitations</h4>${limitations}</section>
<section id="sources"><div class="section-head"><div><span class="eyebrow">Primary evidence</span><h2>Sources</h2></div></div><ul class="source-list">${sourceHtml}</ul></section>
<footer>${esc(get(meta, "repository", "Repository"))} · ${esc(get(meta, "upstream_repository", "ccusage/ccusage"))} · self-contained report with no external assets or tracking</footer>
</main></body></html>`;
}

async function main(): Promise<void> {
  const [inputPath, outputPath, ...extra] = process.argv.slice(2);
  if (!inputPath || !outputPath || extra.length > 0) {
    throw new Error("Usage: bun run render-report.ts <evidence.json> <index.html>");
  }
  const data = asObject(await Bun.file(inputPath).json(), "input");
  const output = render(data);
  await mkdir(dirname(outputPath), { recursive: true });
  await Bun.write(outputPath, output);
  console.log(`Rendered ${outputPath} (${output.length.toLocaleString("en-US")} bytes)`);
}

if (import.meta.main) await main();
