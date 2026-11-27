#!/usr/bin/env node
// decisions — one file per decision (K052, .harness/decisions.md). No dependencies.
//
//   node .harness/tools/decisions.mjs check [--root <dir>] [--log <path>]   exit 1 if the register broke a rule
//   node .harness/tools/decisions.mjs next  [--root <dir>] [--log <path>]   print the next free ID
//   node .harness/tools/decisions.mjs new --supersedes <ID>[,<ID>] [--commits <sha>[,<sha>]] [--title "…"] [--date YYYY-MM-DD]
//        write the next free file as a new decision that points to the one it replaces (K079): the way to
//        change a written decision. --commits names the commits that already changed it, so the audit's C17
//        reads this decision as their record. Prints the path; never overwrites a file.
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
//
// Two facts the audit's C17 and precheck.mjs read from history (K079), both verified, never taken on trust:
// - a verified move: a commit whose every line taken out of the closed log is, word for word and in order,
//   the text of the decision files that same commit adds (`verifiedMove`);
// - a recorded edit: a commit that changed a written decision is answered by a newer decision of the same
//   series that names both the decision and that commit's SHA (`recordedEdit`), as `new --commits` writes.

import { readFileSync, existsSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { plainFail } from './lib.mjs';

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

/** The lines a unified diff (one commit, `git show --format= -p`) takes out of `logFile` and the text of each
 *  file it adds under `folder`: { removed: [line], added: { path: [line] } }, blank lines left out, line ends trimmed. */
export function diffParts(diff, logFile, folder) {
  const removed = [], added = {};
  // a line counts only inside a hunk (after its `@@`), so a removed Markdown bullet (`-- point`) or a removed line
  // that starts with `-- ` is a removed line, never read as a `---` header
  let file = null, isNew = false, inHunk = false;
  for (const l of String(diff || '').split('\n')) {
    const h = l.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (h) { file = h[2]; isNew = false; inHunk = false; continue; }
    if (!inHunk) { if (/^new file mode/.test(l)) isNew = true; if (/^@@ /.test(l)) inHunk = true; continue; }
    if (/^@@ /.test(l)) continue;
    if (file === logFile && l.startsWith('-') && l.slice(1).trim()) removed.push(l.slice(1).trimEnd());
    if (isNew && file && file.startsWith(`${folder}/`) && l.startsWith('+') && l.slice(1).trim()) (added[file] ||= []).push(l.slice(1).trimEnd());
  }
  return { removed, added };
}

/** Is this commit a verified move out of the closed log? Every line it takes out of the log is, word for word and
 *  in order, the text of the decision files it adds (by number), and those files hold nothing else (K079). */
export function verifiedMove(diff, logFile, folder) {
  const { removed, added } = diffParts(diff, logFile, folder);
  return movedWordForWord(removed, added);
}

/** The test behind `verifiedMove`: `removed` (lines out of the log) is exactly the text of the `added` files
 *  (path → lines), taken in the order of their numbers; blank lines and line ends never count. */
export function movedWordForWord(removed, added) {
  const clean = (ls) => ls.map((l) => String(l).trimEnd()).filter((l) => l.trim());
  const base = (f) => f.split('/').pop().replace(/\.md$/, '');
  const files = Object.keys(added).sort((a, b) => (ID.test(base(a)) && ID.test(base(b)) ? num(base(a)) - num(base(b)) : a.localeCompare(b)));
  const out = clean(removed);
  if (!out.length || !files.length) return false;
  if (files.some((f) => fileId(clean(added[f]).join('\n')) !== base(f))) return false;
  const moved = files.flatMap((f) => clean(added[f]));
  return moved.length === out.length && moved.every((l, i) => l === out[i]);
}

/** Is a commit that changed written decisions recorded by a newer one? `ids`: the decisions it changed; `files`:
 *  the register's files (name → text). Each changed ID needs a newer file of its series that names that ID and
 *  at least 7 characters of the commit's SHA (K079). The newer file must not be one the commit changed. */
export function recordedEdit(sha, ids, files) {
  const full = String(sha || '').toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(full) || !ids.length) return false;
  const named = (text) => (String(text).toLowerCase().match(/\b[0-9a-f]{7,40}\b/g) || []).some((t) => full.startsWith(t));
  return ids.every((id) => ID.test(id) && Object.entries(files).some(([name, text]) => {
    const other = name.replace(/\.md$/, '');
    return ID.test(other) && other !== id && pre(other) === pre(id) && num(other) > num(id)
      && new RegExp(`\\b${id}\\b`).test(text) && named(text);
  }));
}

/** A new decision file's text that points to the one it replaces, in the register's own shape (K079). */
export function draft({ id, supersedes = [], commits = [], title = '', date = new Date().toISOString().slice(0, 10), sample = '' }) {
  const what = title || (supersedes.length ? `${supersedes.join(', ')}, as changed` : 'title');
  const head = /^\*\*/.test(String(sample).trim()) ? `**${id}** · ${what}, ${date}` : `## ${id} · ${date} · STANDING — ${what}`;
  const lines = [head, ''];
  if (supersedes.length) {
    lines.push(`**Supersedes** ${supersedes.join(', ')}${commits.length ? `, and records the changes already made to ${supersedes.length > 1 ? 'them' : 'it'} after ${supersedes.length > 1 ? 'they were' : 'it was'} written: ${commits.join(', ')}` : ''}. ${supersedes.length > 1 ? 'They stay' : 'It stays'} as it is, never edited again; this decision is what holds from today.`, '');
  }
  lines.push('**Decision.** <what holds now, and why>', '');
  return `${lines.join('\n')}`;
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
    if (p.length) { plainFail('decisions', `${p[0]}${p.length > 1 ? ` (and ${p.length - 1} more)` : ''}`); process.exit(1); }
    console.log(`decisions: OK · ${logIds(reg.log).length} in ${reg.logFile} (closed), ${Object.keys(reg.files).length} in ${reg.folder}/`);
  } else if (cmd === 'next') {
    const id = nextId(reg);
    if (!id) { console.error(`decisions: no decision yet in ${reg.logFile} or ${reg.folder}/, so the first ID is the project's to choose`); process.exit(1); }
    console.log(id);
  } else if (cmd === 'new') {
    const list = (n) => String(opt(n) || '').split(',').map((x) => x.trim()).filter(Boolean);
    const supersedes = list('--supersedes'), commits = list('--commits');
    const id = nextId(reg);
    if (!id) { console.error(`decisions: no decision yet in ${reg.logFile} or ${reg.folder}/, so the first ID is the project's to choose`); process.exit(1); }
    const bad = supersedes.filter((x) => !ID.test(x) || !(logIds(reg.log).includes(x) || reg.files[`${x}.md`] !== undefined));
    if (bad.length) { console.error(`decisions: ${bad.join(', ')} is no decision of this register`); process.exit(1); }
    if (commits.some((c) => !/^[0-9a-f]{7,40}$/i.test(c))) { console.error('decisions: --commits takes SHAs (7 to 40 hexadecimal characters)'); process.exit(1); }
    if (commits.length && !supersedes.length) { console.error('decisions: --commits needs --supersedes: the commits are changes to the decision it names'); process.exit(1); }
    const path = join(root, reg.folder, `${id}.md`);
    if (existsSync(path)) { console.error(`decisions: ${reg.folder}/${id}.md exists; nothing written`); process.exit(1); }
    const sample = Object.entries(reg.files).sort(([a], [b]) => a.localeCompare(b)).map(([, t]) => t).pop() || reg.log.split('\n').find((l) => ENTRY.test(l)) || '';
    mkdirSync(join(root, reg.folder), { recursive: true });
    writeFileSync(path, draft({ id, supersedes, commits, title: opt('--title') || '', date: opt('--date') || undefined, sample }));
    console.log(`${reg.folder}/${id}.md`);
    if (!supersedes.length) console.error('decisions: written. To change a decision already written, name it: new --supersedes <ID> (a written decision is never edited, C17)');
  } else {
    console.error('usage: decisions.mjs check|next|new [--root <dir>] [--log <path>]  (see the header of this file)');
    process.exit(1);
  }
}
