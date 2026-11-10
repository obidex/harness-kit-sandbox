#!/usr/bin/env node
// stale — the C15 stale-work list (no silent stall) and its capped alerts. No dependencies.
//
//   node .harness/tools/stale.mjs scan --repo owner/name [--config <file>]
//                                         the stale items now (JSON); reads only
//   node .harness/tools/stale.mjs report --repo owner/name [--config <file>]
//                                         in Actions (harness-stale.yml, or a coordinator's daily
//                                         backstop run): scan, then bring the one "Stale work" tracking
//                                         issue up to date (create, edit in place, reopen, or close when
//                                         the list is empty); with ALERTS_OPS_BOARD, one Ops board row
//                                         per stale item (below), and one row `state:<owner/name>` when
//                                         the coordinator's STATE issue is out of date (below). Never a
//                                         message to the owner (K038)
//   node .harness/tools/stale.mjs schedules --repo owner/name [--alert]
//                                         missed scheduled runs: every scheduled workflow whose next
//                                         run (by its cron, after its last scheduled or by-hand run) is more than
//                                         HARNESS_SCHEDULE_OVERDUE_HOURS (36) overdue. GitHub's schedules
//                                         are best-effort, so none is trusted silently. With --alert, an
//                                         Ops board row `schedule:<owner/name>/<file>` (ALERTS_OPS_BOARD)
//                                         for each overdue one, resolved once it has run again (on
//                                         schedule or by hand); never a message to the owner (K038).
//                                         GH_TOKEN needs actions: read and contents: read. Any sender can
//                                         run it (the hands daily check, a host's tick).
//
// Stale means no commit, comment or state change (GitHub's updated_at) for at least its threshold, in
// hours (K035: thresholds are data, not code). The defaults:
//   pr          48   an open PR, classified draft, conflicted, red, green-unmerged or waiting (checks
//                    pending or none); bot PRs count like any other
//   conflict    24   an open PR that cannot merge because of a conflict
//   inbox       24   an open `inbox` request in state queued or working (O14)
//   card        48   an open issue labelled `card` or any `risk:*` label
//   initiative  48   an open issue with one of the `initiative_labels` (a board's Now items)
//   wait        48   an open issue with one of the `wait_labels` (a C22 wait record: a STATE issue, a
//                    queued wake); counted only while an initiative is open, or when none are configured
//   state       48   the open issue labelled `coordinator-state` (wake.md: the coordinator's volatile
//                    state, C17) when it was last written at least this long ago AND a pull request
//                    merged in the repository since: work moved and the state did not follow (K042).
//                    Not a list item: one Ops board row `state:<owner/name>`, ✅ once the issue is
//                    rewritten. A repository with no such issue, or with no merge since, has no row;
//                    an issue already listed as a stale wait record keeps that one row
// The data: the object `stale` in .harness/profile.json, or the file --config names (the same object at
// its top level, for a repository without a profile), then the Actions variables HARNESS_STALE_PR_DAYS,
// _CONFLICT_DAYS, _INBOX_DAYS, _CARD_DAYS (days; kept from 0.13). The object:
//   { "hours": { "pr": 48, ... }, "initiative_labels": ["Now"], "wait_labels": ["coordinator-state"],
//     "watch": ["pr", "card", "inbox", "initiative", "wait"], "alerts_max": 3 }
//
// The tracking issue is found by the hidden marker `<!-- harness-stale -->`: one issue per
// repository, never one per run (RJ02), and only one filed by github-actions[bot] counts, so `report`
// runs in Actions. Stale work is the agents' own backlog, never the owner's (owner, roadmap #59, 8 Nov
// 2026; K038): nothing here reaches Telegram. The tracking issue is the list the coordinator works through
// (resume each item, or close or park it with a reason). Where ALERTS_OPS_BOARD names the Ops board, each
// stale item is also an `ops` row there, `stale:<owner/name>#<number>`, turned ✅ when the item moves or
// closes. A capped Telegram problem an earlier kit opened for an item is closed without a message
// (notify resolve --quiet). `alerts_max` is still read, for old profiles, and no longer used.
// notify.mjs's store is github:<owner/name> (ALERTS_STORE). GH_TOKEN reads the repository and writes the issues.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseInbox } from './inbox.mjs';
import { parseYaml } from './lib.mjs';
import { TOPICS, raise, resolveKey, store, telegram, opsBoard, localTime } from './notify.mjs';

export const MARKER = '<!-- harness-stale -->';
export const TITLE = 'Stale work';
export const MAX_LISTED = 10;
/** Thresholds in hours (K035). */
export const DEFAULTS = Object.freeze({ pr: 48, conflict: 24, inbox: 24, card: 48, initiative: 48, wait: 48, state: 48 });
/** The label of the coordinator's STATE issue (wake.md). */
export const STATE_LABEL = 'coordinator-state';
export const WATCH = Object.freeze(['pr', 'card', 'inbox', 'initiative', 'wait']);
export const ALERTS_MAX = 3;
const ENV_DAYS = { pr: 'HARNESS_STALE_PR_DAYS', conflict: 'HARNESS_STALE_CONFLICT_DAYS', inbox: 'HARNESS_STALE_INBOX_DAYS', card: 'HARNESS_STALE_CARD_DAYS' };
const HOUR = 3600000;
const PR_KINDS = ['draft', 'conflicted', 'red', 'green-unmerged', 'waiting'];

const labelList = (v, name) => {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !x.trim())) throw new Error(`stale: ${name} must be a list of label names`);
  return v.map((x) => x.trim());
};

/** The stale settings: defaults, then the data object (profile `stale` or --config), then the legacy
 *  env variables in days. Anything it cannot read is an error, never a silent default. */
export function settings(data = {}, env = process.env) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error('stale: the settings must be an object');
  const hours = { ...DEFAULTS };
  for (const [k, v] of Object.entries(data.hours || {})) {
    if (!(k in DEFAULTS)) throw new Error(`stale: unknown threshold "${k}" (known: ${Object.keys(DEFAULTS).join(', ')})`);
    if (typeof v !== 'number' || !(v > 0)) throw new Error(`stale: hours.${k} must be a number of hours above 0, not ${JSON.stringify(v)}`);
    hours[k] = v;
  }
  for (const [k, name] of Object.entries(ENV_DAYS)) {
    const v = env[name];
    if (v === undefined || String(v).trim() === '') continue;
    if (!/^\d+(\.\d+)?$/.test(String(v).trim())) throw new Error(`${name} must be a number of days, not "${v}"`);
    hours[k] = Number(v) * 24;
  }
  const watch = data.watch === undefined ? [...WATCH] : labelList(data.watch, 'watch');
  const unknown = watch.filter((w) => !WATCH.includes(w));
  if (unknown.length) throw new Error(`stale: unknown watch "${unknown.join(', ')}" (known: ${WATCH.join(', ')})`);
  const alertsMax = data.alerts_max === undefined ? ALERTS_MAX : data.alerts_max;
  if (!Number.isInteger(alertsMax) || alertsMax < 1 || alertsMax > 10) throw new Error('stale: alerts_max is a whole number from 1 to 10');
  return { hours, watch, alertsMax, initiativeLabels: labelList(data.initiative_labels, 'initiative_labels'), waitLabels: labelList(data.wait_labels, 'wait_labels') };
}

/** The data object: the --config file (the whole file), else the profile's `stale` object, else {}. */
export function loadData(file, profile = '.harness/profile.json') {
  if (file) return JSON.parse(readFileSync(file, 'utf8'));
  try { return JSON.parse(readFileSync(profile, 'utf8'))?.stale || {}; } catch (e) { if (e.code === 'ENOENT') return {}; throw new Error(`stale: ${profile} is not readable JSON (${e.message})`); }
}

/** Whole hours since an ISO time. */
export const idleHours = (updatedAt, now = Date.now()) => Math.max(0, Math.floor((now - Date.parse(updatedAt)) / HOUR));
/** Whole days since an ISO time. */
export const idleDays = (updatedAt, now = Date.now()) => Math.floor(idleHours(updatedAt, now) / 24);
/** Hours as the owner reads them: "52 h", or "3 days 4 h" from two days on. */
export const idleText = (h) => (h < 48 ? `${h} h` : `${Math.floor(h / 24)} days${h % 24 ? ` ${h % 24} h` : ''}`);

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

/** An open issue's kind for this list, or null: initiative, wait, inbox queued/working, card, risk. */
export function classifyIssue(issue, s = settings()) {
  const body = String(issue.body || '');
  if (body.includes(MARKER) || body.includes('<!-- harness-alert:')) return null; // the tracking issue, an alert's own issue
  const labels = (issue.labels || []).map((l) => String(typeof l === 'string' ? l : l.name));
  if (labels.some((l) => s.initiativeLabels.includes(l))) return 'initiative';
  if (labels.some((l) => s.waitLabels.includes(l))) return 'wait';
  if (labels.includes('inbox')) {
    const state = parseInbox(issue.body)?.State;
    if (state === 'queued' || state === 'working') return `inbox ${state}`;
  }
  if (labels.includes('card')) return 'card';
  if (labels.some((l) => /^risk:/.test(l))) return 'risk';
  return null;
}

/** The watch group a kind belongs to: pr, inbox, card, initiative or wait. */
export const groupOf = (kind) => (PR_KINDS.includes(kind) ? 'pr' : String(kind).startsWith('inbox') ? 'inbox' : kind === 'risk' ? 'card' : kind);

/** The threshold, in hours, a candidate's kind must reach. */
export function thresholdFor(kind, hours = DEFAULTS) {
  if (kind === 'conflicted') return hours.conflict;
  const g = groupOf(kind);
  return hours[g] ?? hours.card;
}

/** The stale items among candidates { number, url, title, kind, updatedAt }, longest idle first. Wait
 *  records count only while an initiative is open (or when no initiative label is configured). */
export function select(cands, now = Date.now(), s = settings()) {
  const seen = new Set();
  const initiativeOpen = !s.initiativeLabels.length || cands.some((c) => c.kind === 'initiative');
  return cands
    .filter((c) => c.kind && s.watch.includes(groupOf(c.kind)) && (c.kind !== 'wait' || initiativeOpen))
    .map((c) => ({ ...c, hours: idleHours(c.updatedAt, now), limit: thresholdFor(c.kind, s.hours) }))
    .filter((c) => c.hours >= c.limit && !seen.has(c.number) && seen.add(c.number))
    .map(({ number, url, title, kind, hours, limit }) => ({ number, url, title, kind, hours, limit }))
    .sort((a, b) => b.hours - a.hours || a.number - b.number);
}

// --- the tracking issue's body ---------------------------------------------------------------------
const clean = (s) => String(s || '').replace(/\s+/g, ' ').replace(/[|[\]`<>]/g, (c) => `\\${c}`).replace(/@/g, '@​').trim().slice(0, 120);

/** The body: the list, then the thresholds. */
export function render(items, { s = settings() } = {}) {
  const lines = [MARKER, 'Open work with no commit, comment or change past its threshold (C15, no silent stall), listed once a day.',
    `Resume each item, or close or park it with a one-line reason. Nothing here goes to the owner (K038); with the Ops board each item is also a row there. This issue updates in place and closes when the list is empty.`, ''];
  if (items.length) {
    lines.push('| Item | Kind | Idle | Threshold |', '|---|---|---|---|');
    for (const i of items) lines.push(`| [#${i.number}](${i.url}) ${clean(i.title)} | ${i.kind} | ${idleText(i.hours)} | ${i.limit} h |`);
  } else lines.push('Nothing is stale.');
  const h = s.hours;
  lines.push('', `Thresholds in hours: PRs ${h.pr}, conflicted PRs ${h.conflict}, inbox queued or working ${h.inbox}, \`card\` and \`risk:*\` issues ${h.card}`
    + `${s.initiativeLabels.length ? `, initiatives (${s.initiativeLabels.map((l) => `\`${l}\``).join(', ')}) ${h.initiative}` : ''}${s.waitLabels.length ? `, wait records (${s.waitLabels.map((l) => `\`${l}\``).join(', ')}) ${h.wait}` : ''}. Watching: ${s.watch.join(', ')}.`, '');
  return lines.join('\n');
}

/** The signature of an item set: its numbers, sorted, comma-separated. */
export function signature(list) {
  return [...new Set(list.map((x) => (typeof x === 'number' ? x : x.number)))].sort((a, b) => a - b).join(',');
}

/** One stale item's alert key: stable per item, never a time or a count (O10). */
export const itemKey = (repo, number) => `stale:${repo}#${number}`;
/** The problem text for one stale item (notify.mjs sends it as one line). */
export const itemText = (repo, i) => `Stale ${i.kind} in ${repo}: #${i.number} ${String(i.title || '').replace(/\s+/g, ' ').trim().slice(0, 100)} has had no commit, comment or change for ${idleText(i.hours)} (threshold ${i.limit} h). Resume it or record why it waits.`;

/** The profile's topic (`alerts.topic`), or ''. */
export function profileTopic(file = '.harness/profile.json') {
  try { return String(JSON.parse(readFileSync(file, 'utf8'))?.alerts?.topic || ''); } catch { return ''; }
}

/** The project's topic (ALERTS_TOPIC, else the profile's `alerts.topic`): one of notify.mjs's project topics, or null. */
export function topicOf(v = process.env.ALERTS_TOPIC || profileTopic()) {
  const t = String(v || '').trim();
  return t && t in TOPICS && !['needs', 'good', 'summary', 'daily'].includes(t) ? t : null;
}

// --- the STATE issue's freshness (K042) -----------------------------------------------------------
/** One alert key per repository for its STATE issue. */
export const stateKey = (repo) => `state:${repo}`;
/** Whether a STATE issue is out of date: last written at least `limit` hours ago while pull requests
 *  merged since (`merges` are their merged_at times). Idle with no merge since is not stale: nothing moved. */
export function stateFreshness({ updatedAt, merges = [], now = Date.now(), limit = DEFAULTS.state }) {
  const hours = idleHours(updatedAt, now);
  const since = merges.filter((m) => m && Date.parse(m) > Date.parse(updatedAt)).length;
  return { hours, merges: since, stale: hours >= limit && since > 0 };
}
/** The problem text for an out-of-date STATE issue. */
export const stateText = (repo, f) => `State out of date in ${repo}: #${f.number} was last written ${idleText(f.hours)} ago and ${f.merges} pull request${f.merges === 1 ? '' : 's'} merged since (threshold ${f.limit} h). A coordinator run rewrites it as its last step.`;

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
export async function scan(repo, now = Date.now(), s = settings(loadData())) {
  const cands = [];
  if (s.watch.includes('pr')) {
    const prMin = Math.min(s.hours.pr, s.hours.conflict);
    for (const p of await pages(`/repos/${repo}/pulls?state=open`)) {
      if (idleHours(p.updated_at, now) < prMin) continue; // too fresh for any PR threshold: no more calls
      const full = await api('GET', `/repos/${repo}/pulls/${p.number}`);
      const sha = full.head.sha;
      const runs = (await api('GET', `/repos/${repo}/commits/${sha}/check-runs?per_page=100`)).check_runs || [];
      const combined = await api('GET', `/repos/${repo}/commits/${sha}/status`);
      cands.push({ number: p.number, url: p.html_url, title: p.title, kind: classifyPr(full, checkState(runs, combined)), updatedAt: p.updated_at });
    }
  }
  for (const i of await pages(`/repos/${repo}/issues?state=open`)) {
    if (i.pull_request) continue;
    cands.push({ number: i.number, url: i.html_url, title: i.title, kind: classifyIssue(i, s), updatedAt: i.updated_at });
  }
  return select(cands, now, s);
}

/** The repository's STATE issue (open, labelled `coordinator-state`; the most recently written when
 *  several) with its freshness, or null when it has none. Pull requests are read only once the issue
 *  is old enough to matter. */
export async function stateIssue(repo, now = Date.now(), s = settings(loadData())) {
  const open = (await pages(`/repos/${repo}/issues?state=open&labels=${encodeURIComponent(STATE_LABEL)}`))
    .filter((i) => !i.pull_request && (i.labels || []).some((l) => (typeof l === 'string' ? l : l.name) === STATE_LABEL))
    .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
  if (!open.length) return null;
  const i = open[0], limit = s.hours.state;
  const merges = idleHours(i.updated_at, now) < limit ? []
    : (await api('GET', `/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=1`)).map((p) => p.merged_at);
  return { number: i.number, url: i.html_url, limit, ...stateFreshness({ updatedAt: i.updated_at, merges, now, limit }) };
}

export const AUTHOR = 'github-actions[bot]';
/** Whether an issue is the tracking issue: the marker, filed by Actions' own token. Anyone can type the
 * marker, so an issue by anyone else never counts. */
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

/** Close, without any message, the Telegram problems an earlier kit opened under these keys (K038). */
async function quietClose(st, tg, keep, alerts, errors) {
  for (const inc of (await st.list()).filter((i) => i.open && !i.kind && keep(i.key))) {
    try { alerts[inc.key] = (await resolveKey(st, tg, { key: inc.key, text: 'stale work is the agents\' backlog, not the owner\'s (K038)', quiet: true })).status; }
    catch (e) { errors.push(e); alerts[inc.key] = 'failed'; }
  }
}

/** scan, then update the one tracking issue; with the Ops board, one `ops` row per stale item and ✅ for
 *  each that moved. Never a message to the owner (K038). A board call that fails is logged and left for the
 *  next run (notify.mjs boardSync); GH_TOKEN must be able to write the board's repository. */
export async function report(repo, now = Date.now(), s = settings(loadData())) {
  const items = await scan(repo, now, s);
  const issue = await findTracking(repo);
  const body = render(items, { s });
  let target = issue;
  if (!items.length) {
    if (issue && issue.state === 'open') { await api('PATCH', `/repos/${repo}/issues/${issue.number}`, { body, state: 'closed', state_reason: 'completed' }); console.log(`stale: nothing stale; closed #${issue.number}`); }
    else console.log('stale: nothing stale');
  } else {
    if (!issue) target = await api('POST', `/repos/${repo}/issues`, { title: TITLE, body });
    else if (issue.state !== 'open' || issue.body !== body) target = await api('PATCH', `/repos/${repo}/issues/${issue.number}`, { body, ...(issue.state !== 'open' ? { state: 'open' } : {}) });
    console.log(`stale: ${items.length} item(s) listed in ${target.html_url}`);
  }
  const st = store(process.env.ALERTS_STORE || `github:${repo}`), tg = telegram(), board = opsBoard();
  const alerts = {}, errors = [];
  await quietClose(st, tg, (k) => k === `stale:${repo}` || k.startsWith(`stale:${repo}#`), alerts, errors);
  const stale = new Set(items.map((i) => itemKey(repo, i.number)));
  for (const inc of (await st.list()).filter((i) => i.open && i.kind === 'ops' && i.key.startsWith(`stale:${repo}#`) && !stale.has(i.key))) {
    try { alerts[inc.key] = (await resolveKey(st, tg, { key: inc.key, text: `#${inc.key.split('#').pop()} moved again or closed` }, board)).status; }
    catch (e) { errors.push(e); alerts[inc.key] = 'failed'; }
  }
  if (board) for (const i of items) {
    const key = itemKey(repo, i.number);
    try { alerts[key] = (await raise(st, tg, { kind: 'ops', key, system: repo, who: 'Platform', text: itemText(repo, i), link: i.url }, board)).status; }
    catch (e) { errors.push(e); alerts[key] = 'failed'; }
  }
  else if (items.length) console.log('stale: the list is the tracking issue (no ALERTS_OPS_BOARD, so no board rows); nothing goes to the owner');
  // the STATE issue's freshness: one row per repository, ✅ once the issue is rewritten (or gone)
  let state = null;
  try {
    state = await stateIssue(repo, now, s);
    const key = stateKey(repo);
    // already listed as a stale wait record (its own row, stale:<repo>#<n>): never two rows for one issue
    const listed = state && items.some((i) => i.number === state.number);
    if (listed) state.listed = true;
    const due = !!state?.stale && !listed;
    if (due && board) alerts[key] = (await raise(st, tg, { kind: 'ops', key, system: repo, who: 'Platform', text: stateText(repo, state), link: state.url }, board)).status;
    else if (due) console.log(`stale: ${stateText(repo, state)} (no ALERTS_OPS_BOARD, so no board row)`);
    else if ((await st.list()).some((i) => i.open && i.kind === 'ops' && i.key === key)) alerts[key] = (await resolveKey(st, tg, { key, text: !state ? 'the state issue is closed' : listed ? `#${state.number} is listed as stale work` : `#${state.number} was rewritten` }, board)).status;
  } catch (e) { errors.push(e); alerts[stateKey(repo)] = 'failed'; }
  for (const [k, v] of Object.entries(alerts)) console.log(`stale: alert ${k} ${v}`);
  if (errors.length) throw errors[0];
  return { items, issue: target?.number ?? null, state, alerts, alert: Object.values(alerts).join(',') || 'none' };
}

// --- missed scheduled runs ----------------------------------------------------------------------------
const NAMES = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12, sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const BOUNDS = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
const HOUR_MS = 3600e3;
const RAN = ['schedule', 'workflow_dispatch'];
const RUN_PAGE = 30;
/** A run that counts for its schedule: finished, and not cancelled (a skipped job still ran its schedule). */
export const ranToEnd = (r) => r.status === 'completed' && r.conclusion !== 'cancelled';

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
    // a run by hand (the remedy for a missed one) counts as a run; a push or PR run does not. Only a run
    // that finished counts: one cancelled, or stuck unfinished (queued, waiting), is not a run, so runs
    // created and cancelled behind a stuck one never hide that the work stopped (0.14.1)
    const runs = [];
    let unfinished = 0;
    for (const ev of RAN) {
      const page = (await api('GET', `/repos/${repo}/actions/workflows/${w.id}/runs?event=${ev}&per_page=${RUN_PAGE}`)).workflow_runs || [];
      const real = page.filter(ranToEnd);
      if (real.length) runs.push(real[0]);
      else if (page.length >= RUN_PAGE) unfinished++;
    }
    runs.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    // a full page of runs with none finished, and no other finished run: the last real one is older than the
    // whole page and its age unknown. The page slides forward as new runs are cancelled, so it is missed now
    const none = !runs.length && unfinished > 0;
    const last = runs[0]?.created_at || w.created_at;
    const file = w.path.split('/').pop();
    const st = scheduleState({ crons, last, now, limit });
    out.push({ workflow: w.name || file, file, url: `${w.html_url ? w.html_url.replace(/\/blob\/.*$/, '') : `https://github.com/${repo}`}/actions/workflows/${file}`,
      state: w.state, crons, lastRun: runs[0]?.created_at || null, ...st, ...(none ? { overdue: true, noneFinished: RUN_PAGE } : {}) });
  }
  return out;
}

/** The problem text for one missed schedule (notify.mjs sends it as one line). */
export function missedText(repo, s, limit = 36) {
  const why = s.state === 'disabled_inactivity' ? 'GitHub turned its schedule off for inactivity; turn it back on in Actions' : 'GitHub\'s scheduled runs are best-effort; run it by hand from Actions if it stays missing';
  if (s.noneFinished) return `Scheduled run missed: ${s.workflow} in ${repo}: none of its last ${s.noneFinished} runs finished (cancelled or stuck). ${why}.`;
  return `Scheduled run missed: ${s.workflow} in ${repo} was due ${localTime(s.due)} and is ${s.lateHours} h overdue (more than ${limit} h); last run ${s.lastRun ? localTime(s.lastRun) : 'never'}. ${why}.`;
}

/** schedules, then an Ops board row per overdue workflow and ✅ for each that ran again; never a message
 *  to the owner (K038). Without ALERTS_OPS_BOARD it only lists them. */
export async function alertSchedules(repo, now = Date.now(), board = opsBoard()) {
  const limit = overdueHours();
  const list = await schedules(repo, now, limit);
  const st = store(process.env.ALERTS_STORE || `github:${repo}`), tg = telegram();
  const old = {}, errors = [];
  await quietClose(st, tg, (k) => k.startsWith(`schedule:${repo}/`), old, errors);
  if (errors.length) throw errors[0];
  const done = [];
  for (const s of list) {
    const key = `schedule:${repo}/${s.file}`;
    const r = !board ? { status: s.overdue ? 'listed only (no ALERTS_OPS_BOARD)' : 'ok' } : s.overdue
      ? await raise(st, tg, { kind: 'ops', key, system: repo, who: 'Platform', text: missedText(repo, s, limit), link: s.url }, board)
      : await resolveKey(st, tg, { key, text: `${s.workflow} in ${repo} ran again (${s.lastRun ? localTime(s.lastRun) : 'its next run is not due yet'})` }, board);
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
  const s = () => settings(loadData(opt('--config')));
  if (cmd === 'scan') { console.log(JSON.stringify(await scan(repo, Date.now(), s()), null, 2)); return; }
  if (cmd === 'report') { await report(repo, Date.now(), s()); return; }
  if (cmd === 'schedules') {
    const list = argv.includes('--alert') ? await alertSchedules(repo) : await schedules(repo);
    for (const s of list) console.log(`schedules: ${s.overdue ? 'MISSED' : 'ok'} ${s.file} (${s.crons.join(' | ')}) last ${s.lastRun || 'never'}, due ${s.due}${s.overdue ? `, ${s.lateHours} h overdue` : ''}${s.alert ? `; alert ${s.alert}` : ''}`);
    if (!list.length) console.log(`schedules: no scheduled workflow in ${repo}`);
    return;
  }
  throw new Error('usage: stale.mjs scan|report [--config <file>]|schedules --repo owner/name  (see the header of this file)');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((e) => { console.error(`stale: ${e.message}`); process.exit(1); });
}
