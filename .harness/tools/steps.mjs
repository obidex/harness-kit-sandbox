#!/usr/bin/env node
// steps — the three checks of a runbook or a skill (K070, roadmap item "the linter's three checks").
// No dependencies, no network.
//
//   node .harness/tools/steps.mjs <file.md> [<file.md> …]
//
// A file is checked when it is a skill (`SKILL.md`) or carries the line `<!-- runbook -->`; any other
// file is skipped and named. In a checked file:
//   1. Numbered steps. At least one top-level numbered list (`1.` at the start of a line). Indented
//      sub-steps belong to the step above them.
//   2. A command and a check per step. Each top-level step holds a command (an inline code span outside
//      its check, or a fenced block) and a check: a line or clause beginning `Check:` that says what you see when the
//      step worked. A step with nothing to run says so in a clause `No command:` with the reason; it
//      is counted, never hidden (the report lists it).
//   3. A failure table. A Markdown table whose header names the failure (a column with "fail", "goes
//      wrong", "error", "symptom" or "if") and the fix (a column with "fix", "do", "then" or
//      "action"), with at least one row, where every fix says what to do: never empty and never only
//      "try again", "retry" or "re-run".
//
// Exit 0 = every checked file passes; 1 = a problem, one line each (`file:line: what`); 2 = usage.
// Whether each step has one goal, and whether the check really proves it, stays the reviewer's call.

import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MARK = '<!-- runbook -->';
const STEP = /^(\d+)\.\s+\S/;
const CHECK = /(^|[\s(*_])Check:/;
const NO_CMD = /(^|[\s(*_])No command:\s*\S/;
const BARE_RETRY = /^\s*(?:just\s+)?(?:try(?:\s+it)?\s+again|retry(?:\s+it)?|re-?run(?:\s+it)?|again|run\s+it\s+again)\s*[.!]?\s*$/i;

export const isRunbook = (path, text) => basename(path) === 'SKILL.md' || String(text).split('\n').some((l) => l.trim() === MARK);

/** Lines outside fenced blocks, with a flag for lines inside one. */
function scan(text) {
  const out = [];
  let fence = null;
  for (const [i, line] of String(text).split('\n').entries()) {
    const f = line.match(/^\s*(`{3,}|~{3,})/);
    if (f) { out.push({ n: i + 1, line, fenced: true, fenceEdge: true }); fence = fence ? (f[1][0] === fence ? null : fence) : f[1][0]; continue; }
    out.push({ n: i + 1, line, fenced: Boolean(fence) });
  }
  return out;
}

/** Top-level steps: [{ n, num, lines: [text…], fenced: bool }]. A step runs until the next top-level
 *  step, a heading, or a line that starts at column 0 after a blank line and is not a list item. */
export function steps(text) {
  const out = [];
  let cur = null, blank = false;
  for (const l of scan(text)) {
    if (!l.fenced && /^#{1,6}\s/.test(l.line)) { cur = null; blank = false; continue; }
    const m = !l.fenced && l.line.match(STEP);
    if (m) { cur = { n: l.n, num: Number(m[1]), lines: [l.line], fenced: false }; out.push(cur); blank = false; continue; }
    if (!cur) continue;
    if (l.line.trim() === '') { blank = true; cur.lines.push(''); continue; }
    if (blank && !l.fenced && /^\S/.test(l.line) && !/^\|/.test(l.line)) { cur = null; blank = false; continue; }
    blank = false;
    cur.lines.push(l.line);
    if (l.fenced || l.fenceEdge) cur.fenced = true;
  }
  return out;
}

/** Markdown tables: [{ n, header: [cells], rows: [[cells]] }]. */
export function tables(text) {
  const out = [];
  const ls = scan(text);
  const cells = (s) => s.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  for (let i = 0; i + 1 < ls.length; i++) {
    if (ls[i].fenced || !/^\s*\|.*\|\s*$/.test(ls[i].line) || !/^\s*\|?\s*:?-{3,}/.test(ls[i + 1].line)) continue;
    const t = { n: ls[i].n, header: cells(ls[i].line), rows: [] };
    let j = i + 2;
    for (; j < ls.length && /^\s*\|.*\|\s*$/.test(ls[j].line); j++) t.rows.push(cells(ls[j].line));
    out.push(t);
    i = j - 1;
  }
  return out;
}

const FAIL_COL = /fail|goes wrong|went wrong|error|symptom|\bif\b|what happens/i;
const FIX_COL = /fix|\bdo\b|then|action/i;

/** The problems of one checked text: [{ line, what }], and the steps that declared no command. */
export function lint(text) {
  const p = [], nocmd = [];
  const ss = steps(text);
  if (!ss.length) p.push({ line: 1, what: 'no numbered steps (a top-level "1." list)' });
  for (const s of ss) {
    const body = s.lines.join('\n');
    // a code span inside the Check: clause is what you see, not what you run
    const doing = body.split('\n').map((l) => l.replace(/(^|[\s(*_])Check:.*$/, '$1')).join('\n');
    const hasCmd = s.fenced || /`[^`\n]+`/.test(doing);
    const declared = NO_CMD.test(body);
    if (!hasCmd && !declared) p.push({ line: s.n, what: `step ${s.num} has no command (an inline \`code\` span or a fenced block), and no "No command:" with the reason` });
    if (declared && !hasCmd) nocmd.push(s.n);
    if (!CHECK.test(body)) p.push({ line: s.n, what: `step ${s.num} has no "Check:" saying what you see when it worked` });
  }
  const ft = tables(text).filter((t) => t.header.some((h) => FAIL_COL.test(h)) && t.header.some((h) => FIX_COL.test(h)));
  if (!ft.length) p.push({ line: 1, what: 'no failure table (a table with a failure column and a fix column)' });
  for (const t of ft) {
    const fix = t.header.findIndex((h, i) => i > 0 && FIX_COL.test(h));
    const col = fix >= 0 ? fix : t.header.length - 1;
    if (!t.rows.length) p.push({ line: t.n, what: 'the failure table has no rows' });
    t.rows.forEach((r, k) => {
      const v = (r[col] || '').replace(/[*_`]/g, '');
      if (!v.trim()) p.push({ line: t.n + 2 + k, what: 'a failure has no fix' });
      else if (BARE_RETRY.test(v)) p.push({ line: t.n + 2 + k, what: `a fix only says "${v.trim()}": say what to change or check first` });
    });
  }
  return { problems: p, nocmd, steps: ss.length };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const files = process.argv.slice(2);
  if (!files.length) { console.log('usage: steps.mjs <file.md> [<file.md> …]'); process.exit(2); }
  let bad = 0;
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    if (!isRunbook(f, text)) { console.log(`steps: ${f}: skipped (not a SKILL.md and no ${MARK} line)`); continue; }
    const r = lint(text);
    for (const x of r.problems) console.log(`${f}:${x.line}: ${x.what}`);
    if (r.problems.length) bad++;
    else console.log(`steps: ${f}: OK · ${r.steps} steps${r.nocmd.length ? ` (${r.nocmd.length} with "No command:", lines ${r.nocmd.join(', ')})` : ''}`);
  }
  process.exit(bad ? 1 : 0);
}
