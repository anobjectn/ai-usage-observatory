#!/usr/bin/env python3
"""Render a self-contained dark HTML ccusage upstream audit from evidence JSON."""

from __future__ import annotations

import argparse
import html
import json
from pathlib import Path
from typing import Any


ALLOWED_LEVELS = {"none", "low", "medium", "high", "unknown"}
ALLOWED_STATUSES = {"current", "behind", "ahead", "diverged", "unknown"}


def esc(value: Any) -> str:
    return html.escape(str(value if value is not None else ""), quote=True)


def link(item: dict[str, Any]) -> str:
    label = esc(item.get("label") or item.get("url") or "Source")
    url = esc(item.get("url", ""))
    note = f'<span class="source-note">{esc(item["note"])}</span>' if item.get("note") else ""
    return f'<a href="{url}" target="_blank" rel="noreferrer">{label}<span aria-hidden="true">↗</span></a>{note}'


def pills(items: list[str], kind: str = "plain") -> str:
    return "".join(f'<span class="pill {esc(kind)}">{esc(item)}</span>' for item in items)


def evidence_links(items: list[dict[str, Any]]) -> str:
    if not items:
        return '<span class="muted">No direct link recorded</span>'
    return '<div class="evidence">' + "".join(link(item) for item in items) + "</div>"


def work_list(items: list[Any]) -> str:
    if not items:
        return '<p class="muted">No additional work identified.</p>'
    return "<ul>" + "".join(f"<li>{esc(item)}</li>" for item in items) + "</ul>"


def change_cards(items: list[dict[str, Any]], empty: str) -> str:
    if not items:
        return f'<div class="empty">{esc(empty)}</div>'
    cards = []
    for item in items:
        level = str(item.get("complexity", "unknown")).lower()
        affected = [str(value) for value in item.get("affected_files", [])]
        meta = [value for value in (item.get("version"), item.get("date"), item.get("category")) if value]
        cards.append(f'''<article class="card change-card">
          <div class="card-head"><div>{pills(meta)}<h3>{esc(item.get("title", "Untitled change"))}</h3></div><span class="badge {esc(level)}">{esc(level)}</span></div>
          <p>{esc(item.get("summary", ""))}</p>
          <div class="callout"><strong>Observatory impact</strong><p>{esc(item.get("impact", "Not established."))}</p></div>
          <h4>Required work</h4>{work_list(item.get("required_work", []))}
          {f'<div class="files">{pills(affected, "file")}</div>' if affected else ''}
          {evidence_links(item.get("evidence", []))}
        </article>''')
    return '<div class="card-grid">' + "".join(cards) + "</div>"


def opportunity_cards(items: list[dict[str, Any]]) -> str:
    if not items:
        return '<div class="empty">No new upstream opportunities were established.</div>'
    cards = []
    for item in items:
        effort = str(item.get("effort", "unknown")).lower()
        recommendation = str(item.get("recommendation", "watch")).lower()
        cards.append(f'''<article class="card">
          <div class="card-head"><div><span class="eyebrow">{esc(recommendation)}</span><h3>{esc(item.get("title", "Untitled opportunity"))}</h3></div><span class="badge {esc(effort)}">{esc(effort)} effort</span></div>
          <p>{esc(item.get("value", ""))}</p>
          <div class="callout"><strong>Architecture fit</strong><p>{esc(item.get("fit", "Not assessed."))}</p></div>
          <h4>Work outline</h4>{work_list(item.get("required_work", []))}
          {evidence_links(item.get("evidence", []))}
        </article>''')
    return '<div class="card-grid">' + "".join(cards) + "</div>"


def rows(items: list[dict[str, Any]], columns: list[tuple[str, str]]) -> str:
    if not items:
        return f'<tr><td colspan="{len(columns)}" class="muted">None recorded.</td></tr>'
    return "".join("<tr>" + "".join(f'<td>{esc(item.get(key, "—"))}</td>' for key, _ in columns) + "</tr>" for item in items)


def validate(data: dict[str, Any]) -> None:
    for key in ("metadata", "versions", "assessment"):
        if not isinstance(data.get(key), dict):
            raise ValueError(f"Missing required object: {key}")
    status = str(data["versions"].get("status", "unknown")).lower()
    level = str(data["assessment"].get("complexity", "unknown")).lower()
    if status not in ALLOWED_STATUSES:
        raise ValueError(f"Invalid versions.status: {status}")
    if level not in ALLOWED_LEVELS:
        raise ValueError(f"Invalid assessment.complexity: {level}")
    for key in ("sources", "released_changes", "unreleased_changes", "opportunities", "issues", "local_surface", "validation", "limitations"):
        if key in data and not isinstance(data[key], list):
            raise ValueError(f"Expected array: {key}")


def render(data: dict[str, Any]) -> str:
    validate(data)
    meta, versions, assessment = data["metadata"], data["versions"], data["assessment"]
    status = str(versions.get("status", "unknown")).lower()
    complexity = str(assessment.get("complexity", "unknown")).lower()
    sources = data.get("sources", [])
    issue_items = data.get("issues", [])
    issue_html = "".join(
        f'<li><a href="{esc(item.get("url", ""))}" target="_blank" rel="noreferrer">#{esc(item.get("number", "—"))} {esc(item.get("title", "Untitled issue"))}</a><span class="pill">{esc(item.get("state", "unknown"))}</span><p>{esc(item.get("relevance", ""))}</p></li>'
        for item in issue_items
    ) or '<li class="muted">No directly relevant issues were recorded.</li>'
    source_html = "".join(f"<li>{link(item)}</li>" for item in sources) or '<li class="muted">No sources recorded.</li>'
    limitations = work_list(data.get("limitations", []))
    surface_columns = [("path", "Path"), ("role", "Role"), ("risk", "Risk"), ("notes", "Notes")]
    validation_columns = [("check", "Check"), ("status", "Status"), ("notes", "Notes")]
    title = esc(meta.get("title", "ccusage upstream audit"))
    return f'''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title}</title>
<style>
:root{{--bg:#080b10;--panel:#10151d;--panel2:#151c26;--line:#263140;--text:#eef3f8;--muted:#98a7b8;--cyan:#5ee7f2;--green:#6ee7a8;--amber:#f7c66b;--red:#ff7d8c;--purple:#b9a2ff;--shadow:0 24px 70px rgba(0,0,0,.32)}}
*{{box-sizing:border-box}}html{{color-scheme:dark;scroll-behavior:smooth}}body{{margin:0;background:radial-gradient(circle at 16% -10%,#163445 0,transparent 32rem),radial-gradient(circle at 90% 0,#251c45 0,transparent 28rem),var(--bg);color:var(--text);font:15px/1.6 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}}a{{color:var(--cyan);text-decoration:none}}a:hover{{text-decoration:underline}}.shell{{width:min(1180px,calc(100% - 32px));margin:auto;padding:42px 0 80px}}header{{padding:40px;border:1px solid var(--line);border-radius:24px;background:linear-gradient(135deg,rgba(18,29,39,.96),rgba(14,17,27,.92));box-shadow:var(--shadow);position:relative;overflow:hidden}}header:after{{content:"";position:absolute;width:240px;height:240px;border:1px solid rgba(94,231,242,.18);border-radius:50%;right:-75px;top:-125px;box-shadow:0 0 70px rgba(94,231,242,.12)}}.eyebrow{{color:var(--cyan);font-size:.72rem;font-weight:800;letter-spacing:.14em;text-transform:uppercase}}h1{{font-size:clamp(2rem,6vw,4.25rem);line-height:1;margin:.35rem 0 1rem;letter-spacing:-.045em;max-width:800px}}h2{{font-size:1.6rem;letter-spacing:-.025em;margin:0}}h3{{font-size:1.08rem;line-height:1.3;margin:.45rem 0}}h4{{margin:1.2rem 0 .25rem;font-size:.78rem;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}}p{{margin:.4rem 0 1rem}}.lede{{font-size:1.08rem;color:#c4d0dc;max-width:820px}}.hero-grid{{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-top:30px}}.metric{{padding:16px;border:1px solid var(--line);border-radius:14px;background:rgba(8,11,16,.46)}}.metric span{{display:block;color:var(--muted);font-size:.72rem;text-transform:uppercase;letter-spacing:.08em}}.metric strong{{display:block;font-size:1.25rem;margin-top:4px;overflow-wrap:anywhere}}.badge,.pill{{display:inline-flex;align-items:center;border:1px solid var(--line);background:#18212c;border-radius:999px;padding:4px 9px;font-size:.72rem;font-weight:750;text-transform:uppercase;letter-spacing:.05em;white-space:nowrap}}.badge.none,.badge.low,.badge.current{{color:var(--green);border-color:rgba(110,231,168,.35);background:rgba(110,231,168,.09)}}.badge.medium,.badge.behind{{color:var(--amber);border-color:rgba(247,198,107,.35);background:rgba(247,198,107,.09)}}.badge.high,.badge.failed{{color:var(--red);border-color:rgba(255,125,140,.35);background:rgba(255,125,140,.09)}}.badge.unknown{{color:var(--purple)}}nav{{display:flex;gap:8px;flex-wrap:wrap;padding:18px 0}}nav a{{color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:7px 12px;background:rgba(16,21,29,.75)}}section{{padding:32px 0;border-top:1px solid rgba(38,49,64,.75)}}.section-head{{display:flex;align-items:end;justify-content:space-between;gap:24px;margin-bottom:18px}}.section-head p{{color:var(--muted);margin:0;max-width:600px}}.summary{{padding:24px;border:1px solid rgba(94,231,242,.3);background:rgba(94,231,242,.06);border-radius:18px}}.summary strong{{color:var(--cyan)}}.card-grid{{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}}.card{{border:1px solid var(--line);background:linear-gradient(150deg,var(--panel2),var(--panel));border-radius:18px;padding:22px;box-shadow:0 14px 40px rgba(0,0,0,.16)}}.card-head{{display:flex;align-items:start;justify-content:space-between;gap:18px}}.card-head .pill{{margin-right:6px}}.card p{{color:#bbc7d4}}.callout{{border-left:2px solid var(--purple);padding:4px 0 4px 14px;margin:18px 0}}.callout p{{margin:3px 0}}ul{{padding-left:20px}}.files,.evidence{{display:flex;gap:7px;flex-wrap:wrap;margin-top:16px}}.pill.file{{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:none;letter-spacing:0;color:#b9c8d8}}.evidence a{{display:inline-flex;gap:5px;align-items:center;border-bottom:1px dotted rgba(94,231,242,.55)}}.source-note{{display:block;color:var(--muted);font-size:.8rem}}.source-list,.issue-list{{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;list-style:none;padding:0}}.source-list li,.issue-list li{{padding:16px;border:1px solid var(--line);border-radius:14px;background:var(--panel)}}.issue-list .pill{{margin-left:8px}}.issue-list p{{color:var(--muted);margin:.5rem 0 0}}.table-wrap{{overflow:auto;border:1px solid var(--line);border-radius:16px}}table{{border-collapse:collapse;width:100%;min-width:700px;background:var(--panel)}}th,td{{padding:13px 15px;text-align:left;border-bottom:1px solid var(--line);vertical-align:top}}th{{color:var(--muted);font-size:.72rem;text-transform:uppercase;letter-spacing:.07em;background:#151c25}}tr:last-child td{{border-bottom:0}}.empty{{border:1px dashed var(--line);color:var(--muted);padding:24px;border-radius:16px;text-align:center}}.muted{{color:var(--muted)}}footer{{color:var(--muted);font-size:.82rem;padding-top:24px}}@media(max-width:760px){{header{{padding:25px}}.hero-grid{{grid-template-columns:repeat(2,1fr)}}.card-grid,.source-list,.issue-list{{grid-template-columns:1fr}}.section-head{{display:block}}}}@media print{{body{{background:#fff;color:#111}}.shell{{width:100%;padding:0}}header,.card,table,.source-list li,.issue-list li{{box-shadow:none;background:#fff;color:#111}}nav{{display:none}}}}
</style></head><body><main class="shell">
<header><span class="eyebrow">Upstream dependency intelligence</span><h1>{title}</h1><p class="lede">{esc(assessment.get("summary", ""))}</p>
<div class="hero-grid"><div class="metric"><span>Pinned</span><strong>{esc(versions.get("pinned", "unknown"))}</strong></div><div class="metric"><span>Latest stable</span><strong>{esc(versions.get("latest_stable", "unknown"))}</strong></div><div class="metric"><span>Status</span><strong><span class="badge {esc(status)}">{esc(status)}</span></strong></div><div class="metric"><span>Upgrade complexity</span><strong><span class="badge {esc(complexity)}">{esc(complexity)}</span></strong></div></div></header>
<nav><a href="#assessment">Assessment</a><a href="#released">Released</a><a href="#unreleased">Unreleased</a><a href="#opportunities">Opportunities</a><a href="#issues">Issues</a><a href="#surface">Local surface</a><a href="#sources">Sources</a></nav>
<section id="assessment"><div class="section-head"><div><span class="eyebrow">Decision</span><h2>Upgrade assessment</h2></div><p>Generated {esc(meta.get("generated_at", "unknown time"))}</p></div><div class="summary"><strong>Recommendation</strong><p>{esc(assessment.get("recommendation", "No recommendation recorded."))}</p><span class="muted">Resolved {esc(versions.get("resolved", "unknown"))} · installed {esc(versions.get("installed", "unknown"))} · {esc(versions.get("released_versions_behind", "unknown"))} released version(s) behind</span></div></section>
<section id="released"><div class="section-head"><div><span class="eyebrow">Stable releases</span><h2>Released changes</h2></div><p>Changes between the project pin and the latest stable package.</p></div>{change_cards(data.get("released_changes", []), "No released changes exist between the pin and latest stable version.")}</section>
<section id="unreleased"><div class="section-head"><div><span class="eyebrow">Default branch</span><h2>Unreleased upstream work</h2></div><p>Not part of the latest stable package; do not treat these as upgrade requirements.</p></div>{change_cards(data.get("unreleased_changes", []), "No relevant unreleased changes were established.")}</section>
<section id="opportunities"><div class="section-head"><div><span class="eyebrow">Product fit</span><h2>Observatory opportunities</h2></div><p>Optional capabilities assessed independently from upgrade necessity.</p></div>{opportunity_cards(data.get("opportunities", []))}</section>
<section id="issues"><div class="section-head"><div><span class="eyebrow">Watch list</span><h2>Relevant upstream issues</h2></div></div><ul class="issue-list">{issue_html}</ul></section>
<section id="surface"><div class="section-head"><div><span class="eyebrow">Compatibility boundary</span><h2>Local integration surface</h2></div></div><div class="table-wrap"><table><thead><tr>{''.join(f'<th>{esc(label)}</th>' for _, label in surface_columns)}</tr></thead><tbody>{rows(data.get("local_surface", []), surface_columns)}</tbody></table></div></section>
<section id="validation"><div class="section-head"><div><span class="eyebrow">Confidence</span><h2>Validation performed</h2></div></div><div class="table-wrap"><table><thead><tr>{''.join(f'<th>{esc(label)}</th>' for _, label in validation_columns)}</tr></thead><tbody>{rows(data.get("validation", []), validation_columns)}</tbody></table></div><h4>Limitations</h4>{limitations}</section>
<section id="sources"><div class="section-head"><div><span class="eyebrow">Primary evidence</span><h2>Sources</h2></div></div><ul class="source-list">{source_html}</ul></section>
<footer>{esc(meta.get("repository", "Repository"))} · {esc(meta.get("upstream_repository", "ccusage/ccusage"))} · self-contained report with no external assets or tracking</footer>
</main></body></html>'''


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, help="Evidence JSON path")
    parser.add_argument("output", type=Path, help="Output HTML path")
    args = parser.parse_args()
    data = json.loads(args.input.read_text(encoding="utf-8"))
    output = render(data)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(output, encoding="utf-8")
    print(f"Rendered {args.output} ({len(output):,} bytes)")


if __name__ == "__main__":
    main()
