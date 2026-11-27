#!/usr/bin/env node
// papercut — an agent's own report of friction, filed in one line and left behind (C28, K070).
//
//   node .harness/tools/papercut.mjs file --what <the tool, skill, rule or file> --tried <t>
//        --expected <t> --happened <t> --fix <t> [--by <thread>] [--cause <cause>] [--to owner/name#N]
//                                   one comment on the project's papercut issue, then the issue's
//                                   table is rebuilt from every report; the session carries on
//   node .harness/tools/papercut.mjs fixed --what <name> --note <the PR or release> [--to owner/name#N]
//                                   the reports so far on <name> are fixed; a later one counts again
//   node .harness/tools/papercut.mjs table [--to owner/name#N]      rebuild the table (prints it)
//   node .harness/tools/papercut.mjs due [--to owner/name#N]
//                                   PAPERCUTS: DUE when reports are open and the last digest posted on
//                                   that issue is 7 days old or more (or there is none); else NOT DUE
//   node .harness/tools/papercut.mjs digest --from owner/name#N [--from …] [--post owner/name#N]
//                                   the weekly grouping across projects: one ranked table of what is
//                                   still open, most reports first; --post leaves it on that issue,
//                                   which is what `due` reads (papercuts.md)
//
// --cause marks a failed check's report with one of the four causes of a failed first pass (K079): product,
// flaky (an unreliable test), infrastructure, old-rule (an old finding surfaced by a new rule). The digest
// lists those reports as the known causes, and a known cause seen twice with no fix recorded is flagged:
// the card that answers it is a prevention, not another investigation.
//
// Where (in order): --to; the profile's `papercuts` ("owner/name#N"); else the current repository's
// open issue labelled `papercut`, opened once by this tool when there is none. Never a public
// repository: a report describes the project's own work, so the tool refuses one.
//
// The issue body is the tool's: it carries the count (`<!-- papercut-count: open=N week=M -->`, read
// by a status page) and a table grouped by `--what`. Reports are comments with the marker
// `<!-- papercut -->`; nobody edits them. Exit 0 = filed; 1 = refused (a secret-shaped value, a
// public repository), nothing posted; 2 = usage; 3 = GitHub did not take it. On 1 and 3 the report is
// printed so the session puts it in its closing note's `Found:` line instead, and goes on.

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ghClient, ghPages } from './lib.mjs';
import { scrub } from './scrub.mjs';

export const LABEL = 'papercut';
export const MARK = '<!-- papercut -->';
export const FIXED_MARK = '<!-- papercut-fixed -->';
export const BODY_MARK = '<!-- papercuts -->';
export const DIGEST_MARK = '<!-- papercut-digest -->';
export const FIELDS = ['tried', 'expected', 'happened', 'fix'];
export const CAUSES = Object.freeze({ product: 'product defect', flaky: 'unreliable test', infrastructure: 'infrastructure', 'old-rule': 'old finding under a new rule' });
export const MAX = 400;          // characters a field keeps: a papercut is short by design
const ROWS = 30;                 // table rows kept in the issue body
const WEEK = 7 * 24 * 3600 * 1000;
const SECRETISH = /(ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|ghs_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}|[0-9]{8,10}:AA[A-Za-z0-9_-]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY)/;

/** One line, no attribution, at most MAX characters. */
export const clean = (s) => {
  const one = String(s ?? '').replace(/\s+/g, ' ').trim();
  const t = (scrub(one) || '').trim();
  return t.length > MAX ? `${t.slice(0, MAX - 1)}…` : t;
};
/** The grouping key of a `what`: no code ticks, no case, single spaces. */
export const keyOf = (what) => String(what || '').replace(/`/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

/** The problems with a report, before anything is posted. */
export function problems(r) {
  const p = [];
  if (!clean(r.what)) p.push('--what is required (the tool, skill, rule or file that fought you)');
  for (const f of FIELDS) if (!clean(r[f])) p.push(`--${f} is required`);
  if (r.cause !== undefined && r.cause !== null && !(String(r.cause) in CAUSES)) p.push(`--cause is one of ${Object.keys(CAUSES).join(', ')}`);
  for (const [k, v] of Object.entries(r)) if (SECRETISH.test(String(v ?? ''))) p.push(`--${k} holds something shaped like a secret: never put one in a report`);
  return p;
}

/** The comment for one report. */
export function comment(r, { version } = {}) {
  const what = clean(r.what).replace(/`/g, '');
  const by = clean(r.by);
  return [MARK, `**Papercut** · \`${what}\`${by ? ` · from ${by}` : ''}${version ? ` · kit ${version}` : ''}`,
    `- **Tried:** ${clean(r.tried)}`, `- **Expected:** ${clean(r.expected)}`,
    `- **Happened:** ${clean(r.happened)}`, `- **Fix:** ${clean(r.fix)}`, ...(r.cause ? [`- **Cause:** ${r.cause}`] : [])].join('\n');
}
export const fixedComment = (what, note) => [FIXED_MARK, `**Papercut fixed** · \`${clean(what).replace(/`/g, '')}\` · ${clean(note)}`].join('\n');

/** The reports and fixes among an issue's comments, oldest first. */
export function parse(comments) {
  const out = [];
  for (const c of comments || []) {
    const b = String(c?.body || '');
    const at = c?.created_at || '';
    if (b.trimStart().startsWith(MARK)) {
      const m = b.match(/\*\*Papercut\*\* · `([^`]+)`/);
      if (!m) continue;
      const field = (n) => (b.match(new RegExp(`^- \\*\\*${n}:\\*\\* (.*)$`, 'm')) || [])[1] || '';
      out.push({ kind: 'report', what: m[1], key: keyOf(m[1]), at, url: c.html_url, tried: field('Tried'), expected: field('Expected'), happened: field('Happened'), fix: field('Fix'), cause: field('Cause') in CAUSES ? field('Cause') : '' });
    } else if (b.trimStart().startsWith(FIXED_MARK)) {
      const m = b.match(/\*\*Papercut fixed\*\* · `([^`]+)` · (.*)$/m);
      if (m) out.push({ kind: 'fixed', what: m[1], key: keyOf(m[1]), at, note: m[2] });
    }
  }
  return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

/** Grouped by `what`: { key, what, open (reports since the last fix), total, last, fixed, example }. */
export function groups(items) {
  const g = new Map();
  for (const it of items) {
    const x = g.get(it.key) || { key: it.key, what: it.what, open: 0, total: 0, last: '', fixed: '', example: '', cause: '', sinceFix: 0 };
    if (it.kind === 'fixed') { x.open = 0; x.fixed = it.note; x.sinceFix = 0; } else { x.open++; x.total++; x.last = it.at; x.example = it.fix; if (it.cause) { x.cause = it.cause; x.sinceFix++; } }
    g.set(it.key, x);
  }
  return [...g.values()].sort((a, b) => b.open - a.open || (a.last < b.last ? 1 : a.last > b.last ? -1 : 0));
}

/** The counts a status page reads: open reports, and reports filed in the last 7 days. */
export function counts(items, now = Date.now()) {
  const gs = groups(items);
  return { open: gs.reduce((s, x) => s + x.open, 0), week: items.filter((i) => i.kind === 'report' && now - Date.parse(i.at) <= WEEK).length };
}

/** The issue body: what this is, the count line and the table. */
export function issueBody(items, now = Date.now()) {
  const c = counts(items, now);
  const rows = groups(items).filter((x) => x.open || x.fixed).slice(0, ROWS);
  const stamp = new Date(now).toISOString().replace(/:\d\d\.\d+Z$/, 'Z');
  return [BODY_MARK,
    'Papercuts: one short report each time a tool, a skill, a rule or an instruction fought an agent (kit C28, `.harness/tools/papercut.mjs`). Agents file them as comments and carry on; the tool rewrites this body from the comments, so nobody edits it.',
    '', `<!-- papercut-count: open=${c.open} week=${c.week} -->`, `**Open: ${c.open}** (filed in the last 7 days: ${c.week}) · rebuilt ${stamp}`, '',
    rows.length ? '| What | Open | Total | Last report | Suggested fix (latest) | Last fixed by |' : 'No report yet.',
    ...(rows.length ? ['|---|---|---|---|---|---|', ...rows.map((x) => `| \`${x.what.replace(/\|/g, '/')}\` | ${x.open} | ${x.total} | ${x.last.slice(0, 10) || '—'} | ${(x.example || '—').replace(/\|/g, '/')} | ${(x.fixed || '—').replace(/\|/g, '/')} |`)] : []),
  ].join('\n');
}

/** The cross-project weekly grouping: every still-open group, most reports first. */
export function digest(sets, now = Date.now()) {
  const rows = [];
  for (const { where, items } of sets) for (const x of groups(items)) if (x.open) rows.push({ where, ...x });
  rows.sort((a, b) => b.open - a.open || (a.last < b.last ? 1 : -1));
  const week = sets.reduce((s, x) => s + counts(x.items, now).week, 0);
  const known = [];
  for (const { where, items } of sets) for (const x of groups(items)) if (x.cause) known.push({ where, ...x });
  known.sort((a, b) => b.total - a.total || (a.last < b.last ? 1 : -1));
  const text = [`**Papercuts, ${new Date(now).toISOString().slice(0, 10)}:** ${rows.reduce((s, x) => s + x.open, 0)} open across ${sets.length} issue(s); ${week} filed in the last 7 days.`, '',
    ...(rows.length ? ['| Rank | Where | What | Open | Last | Suggested fix (latest) |', '|---|---|---|---|---|---|',
      ...rows.map((x, i) => `| ${i + 1} | ${x.where} | \`${x.what.replace(/\|/g, '/')}\` | ${x.open} | ${x.last.slice(0, 10)} | ${(x.example || '—').replace(/\|/g, '/')} |`)] : ['Nothing open.'])];
  // the known causes of failed checks (K079): one place, each with its cause and whether a fix is recorded; seen twice
  // with no fix since, the card that answers it is a prevention, not another investigation
  if (known.length) text.push('', '**Known causes of failed checks**', '', '| Where | What | Cause | Seen | Since its last fix | Fix recorded | Next |', '|---|---|---|---|---|---|---|',
    ...known.map((x) => `| ${x.where} | \`${x.what.replace(/\|/g, '/')}\` | ${CAUSES[x.cause]} | ${x.total} | ${x.sinceFix} | ${(x.fixed || '—').replace(/\|/g, '/')} | ${x.sinceFix >= 2 ? '**a prevention card**' : x.sinceFix === 1 ? 'watch: the next one is a prevention' : 'none'} |`));
  return text.join('\n');
}

/** Is the weekly grouping due on this issue? Due when reports are open and no digest was posted in the
 *  last 7 days (less an hour, so a weekly run at a slightly earlier hour still finds it due). */
export function due(comments, now = Date.now()) {
  const open = counts(parse(comments), now).open;
  const last = (comments || []).filter((c) => String(c?.body || '').trimStart().startsWith(DIGEST_MARK)).map((c) => c.created_at).sort().at(-1) || '';
  const age = last ? now - Date.parse(last) : Infinity;
  return { due: open > 0 && age >= WEEK - 3600 * 1000, open, last };
}

/** "owner/name#N" → { repo, issue }; "owner/name" → { repo }. */
export function parseTarget(t) {
  const m = String(t || '').trim().match(/^([\w.-]+\/[\w.-]+)(?:#(\d+))?$/);
  return m ? { repo: m[1], issue: m[2] ? Number(m[2]) : null } : null;
}

// --- GitHub --------------------------------------------------------------------------------------
const api = ghClient('harness-papercut', {
  hint: (status, path) => (status === 401 || status === 403 || status === 404
    ? `. The session's GitHub access does not reach ${(String(path).match(/^\/repos\/([\w.-]+\/[\w.-]+)/) || [])[1] || 'that repository'}: in a cloud session attach it first (add_repo with access "push"), or name a reachable private issue with --to`
    : ''),
});

function originRepo() {
  try {
    const u = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return (u.match(/github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/) || u.match(/\/git\/([\w.-]+\/[\w.-]+?)(?:\.git)?$/) || [])[1] || null;
  } catch { return null; }
}
function profileTarget() {
  const p = '.harness/profile.json';
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')).papercuts || null; } catch { return null; }
}
const version = () => { try { return readFileSync('.harness/VERSION', 'utf8').trim(); } catch { return ''; } };

/** The issue to file on, opened once when the repository has none. Refuses a public repository. */
export async function target(to, { open = true, call = api } = {}) {
  const t = parseTarget(to || profileTarget() || originRepo());
  if (!t) throw Object.assign(new Error('no target: name one with --to owner/name#N (or set "papercuts" in .harness/profile.json)'), { code: 2 });
  const repo = await call('GET', `/repos/${t.repo}`);
  if (repo?.private !== true) throw Object.assign(new Error(`${t.repo} is public: papercuts describe the project's own work, so they go only to a private repository's issue (--to owner/name#N)`), { code: 1 });
  if (t.issue) {
    // never rewrite an issue the tool does not own: a wrong number must not replace a state note
    const i = await call('GET', `/repos/${t.repo}/issues/${t.issue}`);
    if (i?.pull_request || !String(i?.body || '').includes(BODY_MARK)) throw Object.assign(new Error(`${t.repo}#${t.issue} is not a papercut issue (its body has no ${BODY_MARK} line): nothing written; name the papercut issue, or leave --to out so the tool finds or opens it`), { code: 1 });
    return t;
  }
  const { items } = await ghPages(call, `/repos/${t.repo}/issues?labels=${LABEL}&state=open&sort=created&direction=asc`, { max: 2 });
  const found = items.find((i) => !i.pull_request && String(i.body || '').includes(BODY_MARK));
  if (found) return { repo: t.repo, issue: found.number };
  if (!open) throw new Error(`${t.repo} has no open papercut issue`);
  const made = await call('POST', `/repos/${t.repo}/issues`, { title: 'Papercuts', body: issueBody([]), labels: [LABEL] });
  return { repo: t.repo, issue: made.number };
}

async function commentsOf(t, call = api) {
  return (await ghPages(call, `/repos/${t.repo}/issues/${t.issue}/comments`, { max: 20 })).items;
}
const itemsOf = async (t, call = api) => parse(await commentsOf(t, call));
async function rebuild(t, call = api) {
  const items = await itemsOf(t, call);
  const text = issueBody(items);
  await call('PATCH', `/repos/${t.repo}/issues/${t.issue}`, { body: text });
  return { items, text };
}

// --- commands ------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const opts = (n) => argv.flatMap((a, i) => (a === n && argv[i + 1] ? [argv[i + 1]] : []));

async function main() {
  const [cmd] = argv;
  if (cmd === 'file') {
    const r = { what: opt('--what'), tried: opt('--tried'), expected: opt('--expected'), happened: opt('--happened'), fix: opt('--fix'), by: opt('--by'), cause: opt('--cause') };
    const bad = problems(r);
    if (bad.length) { for (const p of bad) console.log(`papercut: REFUSED ${p}`); process.exitCode = bad.some((p) => /secret/.test(p)) ? 1 : 2; return; }
    const text = comment(r, { version: version() });
    try {
      const t = await target(opt('--to'));
      const c = await api('POST', `/repos/${t.repo}/issues/${t.issue}/comments`, { body: text });
      console.log(`papercut: filed ${c.html_url}`);
      try { await rebuild(t); } catch (e) { console.log(`papercut: filed, but the table was not rebuilt (${e.message}); the next report rebuilds it`); }
      console.log('papercut: carry on with the work');
    } catch (e) {
      console.log(`papercut: NOT FILED: ${e.message}`);
      console.log(`papercut: put this in your closing note's Found: line instead, and carry on: papercut ${clean(r.what)}: tried ${clean(r.tried)}; expected ${clean(r.expected)}; happened ${clean(r.happened)}; fix ${clean(r.fix)}`);
      process.exitCode = e.code === 1 ? 1 : 3;
    }
    return;
  }
  if (cmd === 'fixed') {
    const what = opt('--what'), note = opt('--note');
    if (!clean(what) || !clean(note)) { console.log('papercut: fixed needs --what and --note (the PR or release that fixed it)'); process.exitCode = 2; return; }
    if (SECRETISH.test(`${what} ${note}`)) { console.log('papercut: REFUSED --what or --note holds something shaped like a secret'); process.exitCode = 1; return; }
    const t = await target(opt('--to'), { open: false });
    await api('POST', `/repos/${t.repo}/issues/${t.issue}/comments`, { body: fixedComment(what, note) });
    await rebuild(t);
    console.log(`papercut: ${clean(what)} marked fixed on ${t.repo}#${t.issue}`);
    return;
  }
  if (cmd === 'table') {
    const t = await target(opt('--to'), { open: false });
    console.log((await rebuild(t)).text);
    return;
  }
  if (cmd === 'due') {
    const t = await target(opt('--to'), { open: false });
    const d = due(await commentsOf(t));
    console.log(d.due ? `PAPERCUTS: DUE ${d.open} open on ${t.repo}#${t.issue}; last digest ${d.last || 'never'}` : `PAPERCUTS: NOT DUE (${d.open} open; last digest ${d.last || 'never'})`);
    return;
  }
  if (cmd === 'digest') {
    const from = opts('--from'), post = opt('--post');
    if (!from.length || from.some((f) => !parseTarget(f)?.issue) || (post && !parseTarget(post)?.issue)) { console.log('papercut: digest needs one or more --from owner/name#N (and --post owner/name#N, if given)'); process.exitCode = 2; return; }
    const sets = [];
    for (const f of from) {
      try { sets.push({ where: f, items: await itemsOf(parseTarget(f)) }); } catch (e) { console.log(`papercut: could not read ${f} (${e.message}); left out: say so in the report`); }
    }
    // a group stays in the digest while it has open reports, however old; "last 7 days" is a count
    const text = digest(sets);
    console.log(text);
    if (post) {
      const p = await target(post, { open: false });   // private, and a papercut issue
      const missed = from.filter((f) => !sets.some((s) => s.where === f));
      const c = await api('POST', `/repos/${p.repo}/issues/${p.issue}/comments`, { body: [DIGEST_MARK, text, ...(missed.length ? ['', `Not read: ${missed.join(', ')}.`] : [])].join('\n') });
      console.log(`papercut: digest posted ${c.html_url}`);
    }
    if (sets.length < from.length) process.exitCode = 3;
    return;
  }
  console.log('usage: papercut.mjs file|fixed|table|due|digest (see the header)');
  process.exitCode = 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((e) => { console.log(`papercut: ${e.message}`); process.exitCode = e.code === 1 ? 1 : e.code === 2 ? 2 : 3; });
}
