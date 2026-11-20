#!/usr/bin/env node
// decisions — one file per decision (K052, .harness/decisions.md). No dependencies.
//
//   node .harness/tools/decisions.mjs check [--root <dir>] [--log <path>]   exit 1 if the register broke a rule
//   node .harness/tools/decisions.mjs next  [--root <dir>] [--log <path>]   print the next free ID
//
// A project's decisions were one append-only file (the log: profile `canon.decisions`, else
// DECISIONS.md or docs/DECISIONS.md). Two threads that each appended an entry always conflicted on its
// last lines. From K052 a new decision is its own file, `<ID>.md` in the folder `decisions/` beside
// the log, and the log is closed: it keeps every earlier entry and gains none.
//
// What `check` holds:
// - every file in the folder is named `<ID>.md` (letters, then at least three digits) and its first
//   line names that ID, so a file and its number cannot drift apart;
// - a number is used once: no file repeats an ID the log holds, and every file's number is above
//   every number in the log (an entry appended to the log after the switch fails here);
// - one prefix: the files carry the log's letters.
// Two threads that take the same number write the same path, so git shows the clash on the pull
// request before anything merges; the later one renames its file to the next number (never a text merge).

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FOLDER = 'decisions';
const ID = /^([A-Z]{1,3})(\d{3,5})$/;
// an entry's opening line, as the projects write it: `## K051 · …`, `### D290 …`, `**I091** · …`
const ENTRY = /^(?:#{1,4} +|\*\*)([A-Z]{1,3}\d{3,5})\b/;

/** The folder that holds the one-file decisions: `decisions/` beside the log. */
export const folderFor = (log) => join(dirname(log), FOLDER).replace(/^\.\//, '');

/** The IDs a log's entries open with, in order. */
export function logIds(text) {
  return String(text || '').split('\n').map((l) => (l.match(ENTRY) || [])[1]).filter(Boolean);
}

/** The ID a decision file's first non-empty line names, or null. */
export function fileId(text) {
  const first = String(text || '').split('\n').find((l) => l.trim());
  return first ? (first.match(ENTRY) || [])[1] || null : null;
}

const num = (id) => Number(id.match(ID)[2]);
const pre = (id) => id.match(ID)[1];

/** Everything wrong with a register. `log`: the closed log's text ('' if none); `files`: name → text. */
export function problems({ log = '', files = {}, folder = FOLDER }) {
  const out = [];
  const inLog = logIds(log);
  const top = inLog.length ? Math.max(...inLog.map(num)) : 0;
  const prefixes = new Set(inLog.map(pre));
  const seen = new Map();
  for (const [name, text] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    const id = name.replace(/\.md$/, '');
    if (!name.endsWith('.md') || !ID.test(id)) { out.push(`${folder}/${name}: a decision file is named <ID>.md (letters, then the number), one decision each`); continue; }
    const named = fileId(text);
    if (named !== id) out.push(`${folder}/${name}: its first line names ${named || 'no decision'}, not ${id}`);
    // on a case-insensitive disk two spellings are one file; here they are one number twice
    const key = `${pre(id)}${num(id)}`;
    if (seen.has(key)) out.push(`${folder}/${name}: ${id} is also ${folder}/${seen.get(key)}`); else seen.set(key, name);
    if (inLog.some((x) => pre(x) === pre(id) && num(x) === num(id))) out.push(`${folder}/${name}: ${id} is already an entry in the log; take the next free number`);
    else if (num(id) <= top) out.push(`${folder}/${name}: ${id} is not above the log's last number (${top}): the log gained an entry after the switch, or this number is old. New decisions are files; the log is closed`);
    if (prefixes.size && !prefixes.has(pre(id))) out.push(`${folder}/${name}: the log's decisions are ${[...prefixes].join(', ')}…, not ${pre(id)}…`);
  }
  const dup = inLog.filter((x, i) => inLog.indexOf(x) !== i);
  for (const d of new Set(dup)) out.push(`the log holds ${d} twice`);
  return out;
}

/** The next free ID: one above the highest number in the log and the folder, in the log's shape. */
export function nextId({ log = '', files = {} }) {
  const ids = [...logIds(log), ...Object.keys(files).map((n) => n.replace(/\.md$/, '')).filter((x) => ID.test(x))];
  if (!ids.length) return null;
  const last = ids.reduce((a, b) => (num(b) > num(a) ? b : a));
  const width = Math.max(...ids.map((x) => x.match(ID)[2].length));
  return `${pre(last)}${String(num(last) + 1).padStart(width, '0')}`;
}

/** Where a project keeps its log: the profile's `canon.decisions`, else the usual two places. */
export function logPath(root, given) {
  if (given) return given;
  try {
    const d = JSON.parse(readFileSync(join(root, '.harness/profile.json'), 'utf8'))?.canon?.decisions;
    if (typeof d === 'string' && d) return d;
  } catch { /* no profile: the kit itself, or a control repository */ }
  return ['DECISIONS.md', 'docs/DECISIONS.md'].find((p) => existsSync(join(root, p))) || 'DECISIONS.md';
}

/** Read a register from disk: { log, files, folder, logFile }. */
export function load(root, given) {
  const logFile = logPath(root, given), folder = folderFor(logFile);
  const dir = join(root, folder);
  const files = existsSync(dir) ? Object.fromEntries(readdirSync(dir, { withFileTypes: true }).filter((e) => !e.name.startsWith('.'))
    .map((e) => [e.name, e.isFile() ? readFileSync(join(dir, e.name), 'utf8') : ''])) : {};
  return { log: existsSync(join(root, logFile)) ? readFileSync(join(root, logFile), 'utf8') : '', files, folder, logFile };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...argv] = process.argv.slice(2);
  const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const root = resolve(opt('--root') || '.');
  const reg = load(root, opt('--log'));
  if (cmd === 'check') {
    const p = problems(reg);
    for (const x of p) console.log(`decisions: FAIL ${x}`);
    if (p.length) process.exit(1);
    console.log(`decisions: OK · ${logIds(reg.log).length} in ${reg.logFile} (closed), ${Object.keys(reg.files).length} in ${reg.folder}/`);
  } else if (cmd === 'next') {
    const id = nextId(reg);
    if (!id) { console.error(`decisions: no decision yet in ${reg.logFile} or ${reg.folder}/, so the first ID is the project's to choose`); process.exit(1); }
    console.log(id);
  } else {
    console.error('usage: decisions.mjs check|next [--root <dir>] [--log <path>]  (see the header of this file)');
    process.exit(1);
  }
}
