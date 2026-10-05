#!/usr/bin/env node
// stale — the C15 stale-work list (no silent stall). No dependencies.
//
//   node .harness/tools/stale.mjs scan --repo owner/name     the stale items now (JSON); reads only
//   node .harness/tools/stale.mjs report --repo owner/name   in Actions (harness-stale.yml): scan, then
//                                         bring the one "Stale work" tracking issue up to date
//                                         (create, edit in place, reopen, or close when the list is
//                                         empty) and alert through notify.mjs (O10)
//   node .harness/tools/stale.mjs schedules --repo owner/name [--alert]
//                                         missed scheduled runs: every scheduled workflow whose next
//                                         run (by its cron, after its last scheduled or by-hand run) is more than
//                                         HARNESS_SCHEDULE_OVERDUE_HOURS (36) overdue. GitHub's schedules
//                                         are best-effort, so none is trusted silently. With --alert, a
//                                         problem `schedule:<owner/name>/<file>` in the project's topic
//                                         for each overdue one, and `resolve` once it has run again
//                                         (on schedule or by hand).
//                                         GH_TOKEN needs actions: read and contents: read. Any sender can
//                                         run it (the hands daily check, a host's tick).
//
// Stale means idle (no update) for at least:
//   HARNESS_STALE_PR_DAYS        2   an open PR, classified draft, conflicted, red, green-unmerged or
//                                    waiting (checks pending or none); bot PRs count like any other
//   HARNESS_STALE_CONFLICT_DAYS  1   an open PR that cannot merge because of a conflict
//   HARNESS_STALE_INBOX_DAYS     1   an open `inbox` request in state queued or working (O14)
//   HARNESS_STALE_CARD_DAYS      3   an open issue labelled `card` or any `risk:*` label
//
// The tracking issue is found by the hidden marker `<!-- harness-stale -->`: one issue per
// repository, never one per run (RJ02), and only one filed by github-actions[bot] counts, so `report`
// runs in Actions (harness-stale.yml). Its body also carries, as a hidden marker, the item set the
// owner was last told about. Alerts follow the one standard (O10, .harness/alerts.md) through
// notify.mjs, never Telegram directly: when the list holds items not announced before, one problem
// under the key `stale:<owner/name>` in the project's topic (the Actions variable ALERTS_TOPIC), linking
// the issue; when the list is empty, `resolve` on that key. notify.mjs deduplicates, caps and
// escalates; its store is github:<owner/name> (ALERTS_STORE), and without ALERTS_BOT_TOKEN and
// ALERTS_CHAT_ID a problem is recorded as an issue for the next tick to send. GH_TOKEN reads the
// repository and writes the issues.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseInbox } from './inbox.mjs';
import { parseYaml } from './lib.mjs';
import { TOPICS, problem, resolveKey, store, telegram } from './notify.mjs';

export const MARKER = '<!-- harness-stale -->';
export const TITLE = 'Stale work';
export const MAX_LISTED = 10;
export const DEFAULTS = { prDays: 2, conflictDays: 1, inboxDays: 1, cardDays: 3 };
const ENV = { prDays: 'HARNESS_STALE_PR_DAYS', conflictDays: 'HARNESS_STALE_CONFLICT_DAYS', inboxDays: 'HARNESS_STALE_INBOX_DAYS', cardDays: 'HARNESS_STALE_CARD_DAYS' };
const DAY = 86400000;

/** Thresholds in days: the defaults, each overridable by its env variable (empty = default). */
export function thresholds(env = process.env) {
  const out = { ...DEFAULTS };
  for (const [k, name] of Object.entries(ENV)) {
    const v = env[name];
    if (v === undefined || String(v).trim() === '') continue;
    if (!/^\d+(\.\d+)?$/.test(String(v).trim())) throw new Error(`${name} must be a number of days, not "${v}"`);
    out[k] = Number(v);
  }
  return out;
}

/** Whole days since an ISO time. */
export const idleDays = (updatedAt, now = Date.now()) => Math.max(0, Math.floor((now - Date.parse(updatedAt)) / DAY));

const RED = ['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure'];

/** The checks on a commit: red, pending, green or none. `runs` are check runs; `combined` the commit status. */
export function checkState(runs = [], combined = { state: 'pending', total_count: 0 }) {
  const statuses = combined?.total_count || 0;
  if (runs.some((r) => r.status === 'completed' && RED.includes(r.conclusion)) || (statuses && ['failure', 'error'].includes(combined.state))) return 'red';
  if (runs.some((r) => r.status !== 'completed') || (statuses && combined.state === 'pending')) return 'pending';
  return runs.length + statuses ? 'green' : 'none';
}

/** One open PR's kind: draft, conflicted, red, green-unmerged or waiting. */
export function classifyPr(pr, checks) {
  if (pr.draft) return 'draft';
  if (pr.mergeable === false || pr.mergeable_state === 'dirty') return 'conflicted';
  if (checks === 'red') return 'red';
  if (checks === 'green') return 'green-unmerged';
  return 'waiting';
}

/** An open issue's kind for this list, or null: inbox queued/working, card, risk. */
export function classifyIssue(issue) {
  if (String(issue.body || '').includes(MARKER)) return null; // the tracking issue itself
  const labels = (issue.labels || []).map((l) => String(typeof l === 'string' ? l : l.name));
  if (labels.includes('inbox')) {
    const state = parseInbox(issue.body)?.State;
    if (state === 'queued' || state === 'working') return `inbox ${state}`;
  }
  if (labels.includes('card')) return 'card';
  if (labels.some((l) => /^risk:/.test(l))) return 'risk';
  return null;
}

/** The threshold a candidate's kind must reach. */
export function thresholdFor(kind, t) {
  if (kind === 'conflicted') return t.conflictDays;
  if (['draft', 'red', 'green-unmerged', 'waiting'].includes(kind)) return t.prDays;
  if (kind.startsWith('inbox')) return t.inboxDays;
  return t.cardDays;
}

/** The stale items among candidates { number, url, title, kind, updatedAt }, longest idle first. */
export function select(cands, now = Date.now(), t = DEFAULTS) {
  const seen = new Set();
  return cands
    .map((c) => ({ ...c, days: idleDays(c.updatedAt, now) }))
    .filter((c) => c.kind && c.days >= thresholdFor(c.kind, t) && !seen.has(c.number) && seen.add(c.number))
    .map(({ number, url, title, kind, days }) => ({ number, url, title, kind, days }))
    .sort((a, b) => b.days - a.days || a.number - b.number);
}

// --- the tracking issue's body ---------------------------------------------------------------------
const clean = (s) => String(s || '').replace(/\s+/g, ' ').replace(/[|[\]`<>]/g, (c) => `\\${c}`).replace(/@/g, '@​').trim().slice(0, 120);

/** The body: the list, then the hidden markers (announced item set, last alert date). */
export function render(items, { announced = [], t = DEFAULTS } = {}) {
  const lines = [MARKER, 'Open work idle past its threshold (C15, no silent stall), listed once a day by `harness-stale.yml`.',
    'Resume each item or report it STOPPED. This issue updates in place and closes when the list is empty.', ''];
  if (items.length) {
    lines.push('| Item | Kind | Days idle |', '|---|---|---|');
    for (const i of items) lines.push(`| [#${i.number}](${i.url}) ${clean(i.title)} | ${i.kind} | ${i.days} |`);
  } else lines.push('Nothing is stale.');
  lines.push('', `Thresholds in days: PRs ${t.prDays}, conflicted PRs ${t.conflictDays}, inbox queued or working ${t.inboxDays}, \`card\` and \`risk:*\` issues ${t.cardDays}.`, '',
    `<!-- harness-stale-items: ${signature(announced)} -->`, '');
  return lines.join('\n');
}

/** The marker read back from a body: { announced: [numbers] }. */
export function readMarkers(body) {
  const items = String(body || '').match(/<!-- harness-stale-items: ([\d,]*) -->/);
  return { announced: items && items[1] ? items[1].split(',').map(Number) : [] };
}

/** The signature of an item set: its numbers, sorted, comma-separated. */
export function signature(list) {
  return [...new Set(list.map((x) => (typeof x === 'number' ? x : x.number)))].sort((a, b) => a - b).join(',');
}

/** The items not announced before. Deduplication, caps and escalation are notify.mjs's (O10). */
export const freshItems = (items, announced = []) => { const before = new Set(announced); return items.filter((i) => !before.has(i.number)); };

/** The problem text (notify.mjs sends it as one line): at most MAX_LISTED items, new ones first. */
export function message(repo, items, fresh) {
  const isNew = new Set(fresh.map((i) => i.number));
  const ordered = [...items.filter((i) => isNew.has(i.number)), ...items.filter((i) => !isNew.has(i.number))];
  const parts = ordered.slice(0, MAX_LISTED).map((i) => `#${i.number} ${i.kind} ${i.days}d${isNew.has(i.number) ? ' (new)' : ''}`);
  return `Stale work in ${repo}: ${items.length} item(s), ${fresh.length} new: ${parts.join(', ')}${ordered.length > MAX_LISTED ? `, and ${ordered.length - MAX_LISTED} more` : ''}`;
}

/** The topic in the profile (`alerts.topic`), or ''. */
export function profileTopic(file = '.harness/profile.json') {
  try { return String(JSON.parse(readFileSync(file, 'utf8'))?.alerts?.topic || ''); } catch { return ''; }
}

/** The project's topic (ALERTS_TOPIC, else the profile's `alerts.topic`): one of notify.mjs's project topics, or null. */
export function topicOf(v = process.env.ALERTS_TOPIC || profileTopic()) {
  const t = String(v || '').trim();
  return t && t in TOPICS && !['needs', 'daily'].includes(t) ? t : null;
}

// --- GitHub ---------------------------------------------------------------------------------------
async function api(method, path, data) {
  const r = await fetch(`${process.env.GITHUB_API_URL || 'https://api.github.com'}${path}`, {
    method,
    headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'harness-stale',
      ...(process.env.GH_TOKEN ? { authorization: `Bearer ${process.env.GH_TOKEN}` } : {}), ...(data ? { 'content-type': 'application/json' } : {}) },
    body: data ? JSON.stringify(data) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (r.status < 200 || r.status > 299) throw new Error(`${method} ${path} answered ${r.status}: ${JSON.stringify(json).slice(0, 300)}`);
  return json;
}

async function pages(path, max = 30) {
  const out = [];
  for (let page = 1; page <= max; page++) {
    const l = await api('GET', `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    out.push(...l);
    if (l.length < 100) break;
  }
  return out;
}

/** Every stale item of the repository now. */
export async function scan(repo, now = Date.now(), t = thresholds()) {
  const cands = [];
  const prMin = Math.min(t.prDays, t.conflictDays);
  for (const p of await pages(`/repos/${repo}/pulls?state=open`)) {
    if (idleDays(p.updated_at, now) < prMin) continue; // too fresh for any PR threshold: no more calls
    const full = await api('GET', `/repos/${repo}/pulls/${p.number}`);
    const sha = full.head.sha;
    const runs = (await api('GET', `/repos/${repo}/commits/${sha}/check-runs?per_page=100`)).check_runs || [];
    const combined = await api('GET', `/repos/${repo}/commits/${sha}/status`);
    cands.push({ number: p.number, url: p.html_url, title: p.title, kind: classifyPr(full, checkState(runs, combined)), updatedAt: p.updated_at });
  }
  for (const i of await pages(`/repos/${repo}/issues?state=open`)) {
    if (i.pull_request) continue;
    cands.push({ number: i.number, url: i.html_url, title: i.title, kind: classifyIssue(i), updatedAt: i.updated_at });
  }
  return select(cands, now, t);
}

export const AUTHOR = 'github-actions[bot]';
/** Whether an issue is the tracking issue: the marker, filed by Actions' own token. Anyone can type the
 * marker, so an issue by anyone else never counts (it could otherwise claim every item was announced). */
export const isTracking = (i) => !i.pull_request && String(i.body || '').includes(MARKER) && i.user?.login === AUTHOR && i.user?.type === 'Bot';

/** The tracking issue (open first, then the most recently updated closed one), or null. */
async function findTracking(repo) {
  for (const state of ['open', 'closed']) {
    for (let page = 1; page <= (state === 'open' ? 30 : 10); page++) {
      const l = await api('GET', `/repos/${repo}/issues?state=${state}&sort=updated&direction=desc&per_page=100&page=${page}`);
      const hit = l.find(isTracking);
      if (hit) return hit;
      if (l.length < 100) break;
    }
  }
  return null;
}

/** scan, then update the one tracking issue and alert through notify.mjs. */
export async function report(repo, now = Date.now()) {
  const t = thresholds();
  const items = await scan(repo, now, t);
  const issue = await findTracking(repo);
  const prev = readMarkers(issue?.body);
  const fresh = freshItems(items, prev.announced);
  const key = `stale:${repo}`;
  const alerts = () => store(process.env.ALERTS_STORE || `github:${repo}`);
  const topic = topicOf();
  // with no topic set nothing is announced yet, so the first run that has one alerts for the list
  const announced = fresh.length && !topic ? prev.announced.filter((n) => items.some((i) => i.number === n)) : items.map((i) => i.number);
  const body = render(items, { announced, t });
  if (!items.length) {
    if (issue && issue.state === 'open') { await api('PATCH', `/repos/${repo}/issues/${issue.number}`, { body, state: 'closed', state_reason: 'completed' }); console.log(`stale: nothing stale; closed #${issue.number}`); }
    else console.log('stale: nothing stale');
    const r = await resolveKey(alerts(), telegram(), { key, text: `nothing stale in ${repo}` });
    if (r.status !== 'none') console.log(`stale: alert ${key} ${r.status}`);
    return { items, issue: issue?.number ?? null, alert: r.status };
  }
  let target = issue;
  if (!issue) target = await api('POST', `/repos/${repo}/issues`, { title: TITLE, body });
  else if (issue.state !== 'open' || issue.body !== body) target = await api('PATCH', `/repos/${repo}/issues/${issue.number}`, { body, ...(issue.state !== 'open' ? { state: 'open' } : {}) });
  console.log(`stale: ${items.length} item(s) listed in ${target.html_url} (${fresh.length} new)`);
  if (!fresh.length) return { items, issue: target.number, alert: 'nothing new' };
  if (!topic) { console.log('stale: no alert: set alerts.topic in .harness/profile.json (or the Actions variable ALERTS_TOPIC) to this project\'s topic (.harness/alerts.md)'); return { items, issue: target.number, alert: 'no topic' }; }
  try {
    const r = await problem(alerts(), telegram(), { key, topic, title: `Stale work in ${repo}`, text: message(repo, items, fresh), link: target.html_url });
    console.log(`stale: alert ${key} ${r.status}`);
    return { items, issue: target.number, alert: r.status };
  } catch (e) {
    // not delivered: keep the new items unannounced, so the next run asks notify.mjs again
    await api('PATCH', `/repos/${repo}/issues/${target.number}`, { body: render(items, { announced: prev.announced.filter((n) => items.some((i) => i.number === n)), t }) });
    throw e;
  }
}

// --- missed scheduled runs ----------------------------------------------------------------------------
const NAMES = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12, sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const BOUNDS = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
const HOUR_MS = 3600e3;
const RAN = ['schedule', 'workflow_dispatch'];

/** A five-field cron (GitHub's, UTC) as sets of allowed values; throws on what it cannot read. */
export function parseCron(expr) {
  const f = String(expr || '').trim().split(/\s+/);
  if (f.length !== 5) throw new Error(`cron "${expr}" does not have five fields`);
  const sets = f.map((field, k) => {
    const [lo, hi] = BOUNDS[k]; const out = new Set();
    for (const part of field.split(',')) {
      const m = part.toLowerCase().match(/^(\*|[a-z0-9]+(?:-[a-z0-9]+)?)(?:\/(\d+))?$/);
      if (!m) throw new Error(`cron "${expr}": cannot read "${part}"`);
      const num = (v) => { const n = /^\d+$/.test(v) ? Number(v) : NAMES[v]; if (n === undefined || n < lo || n > hi) throw new Error(`cron "${expr}": "${v}" is out of range`); return n; };
      let [a, b] = m[1] === '*' ? [lo, hi] : m[1].split('-').map(num);
      if (b === undefined) b = m[2] ? hi : a;
      const step = m[2] ? Number(m[2]) : 1;
      if (!step || a > b) throw new Error(`cron "${expr}": cannot read "${part}"`);
      for (let v = a; v <= b; v += step) out.add(k === 4 && v === 7 ? 0 : v);
    }
    return out;
  });
  return { min: sets[0], hour: sets[1], dom: sets[2], month: sets[3], dow: sets[4], domAny: f[2] === '*', dowAny: f[4] === '*' };
}

/** The first time (ms) strictly after t that the cron fires, in UTC. Day of month and day of week
 * combine with OR when both are restricted, as cron does. */
export function nextRun(expr, t) {
  const c = typeof expr === 'string' ? parseCron(expr) : expr;
  const d = new Date(Math.floor(t / 60000) * 60000 + 60000);
  for (let guard = 0; guard < 200000; guard++) {
    const dayOk = c.domAny && c.dowAny ? true : c.domAny ? c.dow.has(d.getUTCDay()) : c.dowAny ? c.dom.has(d.getUTCDate()) : c.dom.has(d.getUTCDate()) || c.dow.has(d.getUTCDay());
    if (!c.month.has(d.getUTCMonth() + 1)) { d.setUTCMonth(d.getUTCMonth() + 1, 1); d.setUTCHours(0, 0, 0, 0); continue; }
    if (!dayOk) { d.setUTCDate(d.getUTCDate() + 1); d.setUTCHours(0, 0, 0, 0); continue; }
    if (!c.hour.has(d.getUTCHours())) { d.setUTCHours(d.getUTCHours() + 1, 0, 0, 0); continue; }
    if (!c.min.has(d.getUTCMinutes())) { d.setUTCMinutes(d.getUTCMinutes() + 1, 0, 0); continue; }
    return d.getTime();
  }
  throw new Error(`cron "${expr}" never fires`);
}

/** Hours a schedule may be late before it counts as missed (HARNESS_SCHEDULE_OVERDUE_HOURS, default 36). */
export function overdueHours(env = process.env) {
  const v = env.HARNESS_SCHEDULE_OVERDUE_HOURS;
  if (v === undefined || String(v).trim() === '') return 36;
  if (!/^\d+(\.\d+)?$/.test(String(v).trim())) throw new Error(`HARNESS_SCHEDULE_OVERDUE_HOURS must be a number of hours, not "${v}"`);
  return Number(v);
}

/** One workflow's schedule state: the next run due after `last` (its last scheduled or by-hand run, or when the
 * workflow appeared), and whether that is more than `limit` hours ago. */
export function scheduleState({ crons, last, now = Date.now(), limit = 36 }) {
  const due = Math.min(...crons.map((c) => nextRun(c, Date.parse(last))));
  const late = (now - due) / HOUR_MS;
  return { due: new Date(due).toISOString(), lateHours: Math.max(0, Math.floor(late)), overdue: late > limit };
}

/** Every scheduled workflow of the repository with its state. A workflow turned off by hand is left
 * out; one GitHub turned off for inactivity is kept, since it will never run again by itself. */
export async function schedules(repo, now = Date.now(), limit = overdueHours()) {
  const out = [];
  const list = (await api('GET', `/repos/${repo}/actions/workflows?per_page=100`)).workflows || [];
  for (const w of list) {
    if (w.state === 'disabled_manually' || !/^\.github\/workflows\/[^/]+\.ya?ml$/.test(w.path || '')) continue;
    let crons = [];
    try {
      const file = await api('GET', `/repos/${repo}/contents/${w.path}`);
      crons = (parseYaml(Buffer.from(file.content || '', 'base64').toString('utf8'))?.on?.schedule || []).map((x) => x?.cron).filter(Boolean);
    } catch (e) { if (!/answered 404/.test(e.message)) throw e; }
    if (!crons.length) continue;
    // a run by hand (the remedy for a missed one) counts as a run; a push or PR run does not
    const runs = [];
    for (const ev of RAN) runs.push(...((await api('GET', `/repos/${repo}/actions/workflows/${w.id}/runs?event=${ev}&per_page=1`)).workflow_runs || []));
    runs.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    const last = runs[0]?.created_at || w.created_at;
    const file = w.path.split('/').pop();
    out.push({ workflow: w.name || file, file, url: `${w.html_url ? w.html_url.replace(/\/blob\/.*$/, '') : `https://github.com/${repo}`}/actions/workflows/${file}`,
      state: w.state, crons, lastRun: runs[0]?.created_at || null, ...scheduleState({ crons, last, now, limit }) });
  }
  return out;
}

/** The problem text for one missed schedule (notify.mjs sends it as one line). */
export function missedText(repo, s, limit = 36) {
  const why = s.state === 'disabled_inactivity' ? 'GitHub turned its schedule off for inactivity; turn it back on in Actions' : 'GitHub\'s scheduled runs are best-effort; run it by hand from Actions if it stays missing';
  return `Scheduled run missed: ${s.workflow} in ${repo} was due ${s.due.slice(0, 16).replace('T', ' ')} UTC and is ${s.lateHours} h overdue (more than ${limit} h); last run ${s.lastRun ? s.lastRun.slice(0, 16).replace('T', ' ') + ' UTC' : 'never'}. ${why}.`;
}

/** schedules, then a problem per overdue workflow and a resolve for each that ran again. */
export async function alertSchedules(repo, now = Date.now(), topic = topicOf()) {
  if (!topic) throw new Error('no topic: set ALERTS_TOPIC (or alerts.topic in .harness/profile.json) to the topic for missed runs');
  const limit = overdueHours();
  const list = await schedules(repo, now, limit);
  const st = store(process.env.ALERTS_STORE || `github:${repo}`), tg = telegram();
  const done = [];
  for (const s of list) {
    const key = `schedule:${repo}/${s.file}`;
    const r = s.overdue
      ? await problem(st, tg, { key, topic, title: `Scheduled run missed: ${s.workflow}`, text: missedText(repo, s, limit), link: s.url })
      : await resolveKey(st, tg, { key, text: `${s.workflow} in ${repo} ran again (${s.lastRun ? s.lastRun.slice(0, 16).replace('T', ' ') + ' UTC' : 'its next run is not due yet'})` });
    done.push({ ...s, alert: r.status });
  }
  return done;
}

// --- commands -------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };

async function main() {
  const [cmd] = argv;
  const repo = opt('--repo');
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('--repo owner/name is required');
  if (cmd === 'scan') { console.log(JSON.stringify(await scan(repo), null, 2)); return; }
  if (cmd === 'report') { await report(repo); return; }
  if (cmd === 'schedules') {
    const list = argv.includes('--alert') ? await alertSchedules(repo) : await schedules(repo);
    for (const s of list) console.log(`schedules: ${s.overdue ? 'MISSED' : 'ok'} ${s.file} (${s.crons.join(' | ')}) last ${s.lastRun || 'never'}, due ${s.due}${s.overdue ? `, ${s.lateHours} h overdue` : ''}${s.alert ? `; alert ${s.alert}` : ''}`);
    if (!list.length) console.log(`schedules: no scheduled workflow in ${repo}`);
    return;
  }
  throw new Error('usage: stale.mjs scan|report|schedules --repo owner/name  (see the header of this file)');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((e) => { console.error(`stale: ${e.message}`); process.exit(1); });
}
