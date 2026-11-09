#!/usr/bin/env node
// wake — disposable, event-fired coordinator runs (K033, .harness/wake.md). No dependencies.
//
//   node .harness/tools/wake.mjs fire --repo owner/name --event <labeled|unlabeled|schedule|workflow_dispatch>
//        [--issue <n>] [--label <name>]
//                                         in Actions only (harness-wake.yml): decide whether this event
//                                         starts a fresh coordinator run, and if so fire the project's
//                                         scheduled task (WAKE_ROUTINE_URL, WAKE_ROUTINE_TOKEN) and post
//                                         the run's session link as the receipt
//   node .harness/tools/wake.mjs status --repo owner/name
//                                         the state the next decision reads (JSON; reads only)
//
// The contract (.harness/wake.md):
// - A wake is the label `wake` on an issue or pull request, never a comment. Anyone with triage on the
//   repository may set it: a person, a job, or a coordinator run that hands work to the next one.
// - One run at a time: the claim label `coordinator-running`. This job sets it on the STATE issue
//   before firing; the run removes it as its last step. A claim on any open issue counts, so replacing
//   the STATE issue never makes room for a second run. Its removal is an event: if issues still carry
//   `wake`, the next run starts. A claim older than CLAIM_TTL_H hours is a run that died, and is cleared.
// - The STATE issue: opened by this job (github-actions[bot]) with the label `coordinator-state` and
//   the marker <!-- coordinator-state -->. Its body is the run's state; each run reads it first and
//   writes it last. It holds no count: nothing about it can reset a cap.
// - Caps: every attempt is a receipt comment by github-actions[bot], posted BEFORE the fire and read
//   from the whole repository (LEDGER_DAYS back; a cut-off listing fails closed; a job comment edited
//   later counts as a run whatever it says). DAILY_CAP runs per repository per 24 hours
//   (WAKE_DAILY_CAP may lower it, never raise it), ISSUE_CAP per issue per 24 hours.
// - Stops that hold until a person lifts them (labels, so they never age out):
//   `wake-stopped` on an issue that started ISSUE_TOTAL runs in LEDGER_DAYS, or that STUCK_STOP backstop
//   runs in a row did not move (one red exception each); `wake-paused` on the STATE issue after
//   STUCK_STOP failed starts in a row, CHAIN_STOP hand-off runs in a row, or a run that keeps dying
//   (lifted only by a run started by hand); `backstop-off` on the STATE issue after EMPTY_STOP empty days (lifted by the next run).
//   The daily backstop starts a run only for work a script can see (a queued wake, a dead run's claim,
//   C15 stale work other than drafts). Labels are removed by the owner's account; agents never do (C12).
// - Nothing is lost when a wake is refused (a run already on, a cap): the label stays, and the end of
//   the running run, or the next backstop, picks it up.

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const WAKE = 'wake';
export const CLAIM = 'coordinator-running';
export const STATE = 'coordinator-state';
export const STATE_MARK = '<!-- coordinator-state -->';
export const FIRE_MARK = '<!-- wake-fire ';            // + JSON + ' -->': a receipt, posted BEFORE the fire
export const FAIL_MARK = '<!-- wake-fail -->';         // the fire after the last receipt did not start
export const EMPTY_MARK = '<!-- wake-backstop-empty -->';
export const STUCK_MARK = '<!-- wake-stuck ';          // + JSON + ' -->': the backstop stopped on no progress
export const CAPPED_MARK = '<!-- wake-capped -->';
export const STOPPED = 'wake-stopped';     // on an issue: the job stopped waking for it; only a person removes it
export const PAUSED = 'wake-paused';       // on the STATE issue: no run starts except by hand (failed starts, a chain)
export const BACKSTOP_OFF = 'backstop-off'; // on the STATE issue: the backstop rests; the next run removes it
export const BOT = 'github-actions[bot]';
export const DAILY_CAP = 8;          // runs per repository per 24 h, hard ceiling
export const ISSUE_CAP = 3;          // runs per woken issue per 24 h
export const ISSUE_TOTAL = 9;        // runs per woken issue in LEDGER_DAYS, then the issue is stopped for good
export const CLAIM_TTL_H = 6;        // a claim older than this belongs to a run that died
export const EMPTY_STOP = 3;         // empty backstops in a row, then the backstop stops
export const STUCK_STOP = 3;         // backstop runs in a row for the same work, or failed fires in a row: stop
export const CHAIN_STOP = 8;         // hand-off runs in a row with no outside wake between, then pause
export const LEDGER_DAYS = 30;       // how far back the receipts are read
const HOUR = 3600e3, DAY = 24 * HOUR;

/** The daily cap: WAKE_DAILY_CAP may lower it, never raise it; anything unreadable is the ceiling. */
export function capFrom(v) {
  const n = /^\s*\d+\s*$/.test(String(v ?? '')) ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(n, DAILY_CAP) : DAILY_CAP;
}

const byJob = (c) => c?.user?.login === BOT && c?.user?.type === 'Bot';

/** The STATE issue among issues: one the job opened, carrying the marker. It holds the run's state
 *  only: no cap, no claim and no count depends on which issue it is. */
export const isState = (i) => !i.pull_request && byJob(i) && String(i.body || '').includes(STATE_MARK);

const json = (b, mark) => { try { return JSON.parse(b.slice(mark.length, b.indexOf(' -->'))); } catch { return {}; } };

/** The job's own marker comments, from anywhere in the repository, oldest first:
 *  { kind: fire|fail|empty|stuck, at, issue, via, sig }. A comment a person posted never counts. */
export function ledger(comments) {
  const out = [];
  for (const c of comments) {
    if (!byJob(c)) continue;
    const b = String(c.body || ''), at = Date.parse(c.created_at);
    // the job never edits its comments: an edited one is counted as a run, whatever it says now
    if (c.updated_at && Math.abs(Date.parse(c.updated_at) - at) > 5000) { out.push({ kind: 'fire', at, issue: null, via: 'edited', sig: '' }); continue; }
    if (b.startsWith(FIRE_MARK)) {
      const j = json(b, FIRE_MARK);
      out.push({ kind: 'fire', at, issue: Number.isInteger(j.issue) ? j.issue : null, via: String(j.via || ''), sig: String(j.sig || '') });
    } else if (b.startsWith(FAIL_MARK)) out.push({ kind: 'fail', at });
    else if (b.startsWith(EMPTY_MARK)) out.push({ kind: 'empty', at });
    else if (b.startsWith(STUCK_MARK)) out.push({ kind: 'stuck', at, sig: String(json(b, STUCK_MARK).sig || '') });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** The work a backstop run would be for, as a stable signature. */
export const signature = (queue, work, dead) => [...queue.map((n) => `w${n}`), ...work.map((w) => `s${w.number}`).sort(), dead ? 'dead' : ''].filter(Boolean).join(',');

/** Fires in a row, newest last, whose start failed (each receipt followed by a fail mark). */
export function failStreak(led) {
  let n = 0;
  for (let i = led.length - 1; i >= 0; i--) {
    if (led[i].kind !== 'fire') continue;
    const next = led.slice(i + 1).find((e) => e.kind === 'fire' || e.kind === 'fail');
    if (next?.kind === 'fail') n++; else break;
  }
  return n;
}

/** Runs in a row, newest last, with no outside wake between: started by a run ending, or by the
 *  backstop for a queued wake. Only a wake label seen while no run was on, or a run by hand, resets it. */
export const chainLength = (fires) => {
  let n = 0;
  for (let i = fires.length - 1; i >= 0; i--) {
    const f = fires[i];
    if (f.via === 'queue' || (f.via === 'backstop' && f.issue != null) || f.via === 'edited') n++;
    else if (f.via === 'backstop') continue;   // a stale-work run neither extends nor ends a chain
    else break;
  }
  return n;
};

/** What this event does. Pure: every input is read before, every effect is done after.
 *  in: { event, label, issue: { number, open, labels, isState } | null, claim, paused, backstopOff,
 *        ledger, queue: [n] (issues stopped for good left out), work: [items], now, cap }
 *  out: { act: fire|empty|stuck|pause|stop-item|capped|none, why, target, via, sig, items, clearClaim, last, n } */
export function decide({ event, label, issue = null, claim = false, paused = false, backstopOff = false, ledger: led = [], queue = [], work = [], now = Date.now(), cap = DAILY_CAP }) {
  const fires = led.filter((e) => e.kind === 'fire');
  const lastFire = fires.at(-1);
  const recent = fires.filter((e) => now - e.at < DAY);
  const dead = claim && (!lastFire || now - lastFire.at > CLAIM_TTL_H * HOUR);
  const busy = claim && !dead;
  const total = (n) => fires.filter((e) => e.issue === n).length;
  const issueCapped = (n) => recent.filter((e) => e.issue === n).length >= ISSUE_CAP;
  const open = queue.filter((n) => !issueCapped(n));
  let target = null, why, via, sig = '';
  if (event === 'labeled') {
    if (label !== WAKE || !issue || !issue.open || !issue.labels.includes(WAKE) || issue.isState) return { act: 'none', why: 'not a wake on an open issue' };
    if (issue.labels.includes(STOPPED)) return { act: 'none', why: `#${issue.number} is stopped (${STOPPED}); a person removes that label to wake for it again` };
    target = issue.number; why = 'wake label'; via = 'label';
  } else if (event === 'unlabeled') {
    if (label !== CLAIM) return { act: 'none', why: 'not the end of a run' };
    if (claim) return { act: 'none', why: 'a claim is still on' };
    if (!queue.length) return { act: 'none', why: 'the run ended and nothing is queued' };
    if (!open.length) return { act: 'none', why: 'the run ended; every queued wake is at its daily cap, so the backstop takes them later' };
    target = open[0]; why = 'queued wake after a run ended'; via = 'queue';
  } else if (event === 'schedule') {
    const empties = led.filter((e) => e.kind === 'empty' && (!lastFire || e.at > lastFire.at)).length;
    if (backstopOff || empties >= EMPTY_STOP) return { act: 'none', why: 'the backstop rests until the next run re-arms it' };
    if (paused) return { act: 'empty', why: 'backstop: wakes are paused', last: empties + 1 >= EMPTY_STOP, n: empties + 1 };
    if (busy) return { act: 'none', why: 'backstop: a run is on' };
    sig = signature(open, work, dead);
    if (!sig) return { act: 'empty', why: queue.length ? 'backstop: only wakes at their daily cap' : 'backstop: nothing to do', last: empties + 1 >= EMPTY_STOP, n: empties + 1 };
    // no progress: the last STUCK_STOP runs were all backstop runs for this same work
    const tail = fires.slice(-STUCK_STOP);
    if (tail.length === STUCK_STOP && tail.every((e) => e.via === 'backstop' && e.sig === sig)) {
      const items = [...open, ...work.map((w) => w.number)];
      // nothing to label (only a run that keeps dying): pause everything instead
      if (!items.length) return { act: 'pause', why: `${STUCK_STOP} backstop runs in a row died holding the claim`, clearClaim: dead };
      return { act: 'stuck', why: `${STUCK_STOP} backstop runs in a row for the same work changed nothing`, sig, items };
    }
    target = open[0] ?? null; via = 'backstop';
    why = open.length ? 'backstop: a wake still queued' : dead ? 'backstop: a run died holding the claim' : `backstop: stale item(s) ${work.map((w) => `#${w.number}`).join(' ')}`;
  } else if (event === 'workflow_dispatch') {
    if (issue && (!issue.open || issue.isState)) return { act: 'none', why: 'not an open issue to wake for' };
    target = issue ? issue.number : null; why = 'started by hand'; via = 'hand';
  } else return { act: 'none', why: `event ${event} wakes nobody` };
  if (busy) return { act: 'none', why: 'a run is on; it reads the wake queue before it ends, and its end starts the next run', target };
  if (via !== 'hand') {
    if (paused) return { act: 'none', why: `wakes are paused (${PAUSED}); only a run started by hand lifts it`, target };
    const fails = failStreak(led);
    if (fails >= STUCK_STOP) return { act: 'pause', why: `the last ${fails} starts failed`, target };
    if (via === 'queue' && chainLength(fires) >= CHAIN_STOP) return { act: 'pause', why: `${CHAIN_STOP} runs in a row were started only by hand-offs between runs`, target };
  }
  if (recent.length >= cap) return { act: 'capped', why: `the daily cap is reached (${recent.length} of ${cap} runs in 24 h)`, target };
  if (target != null && total(target) >= ISSUE_TOTAL) return { act: 'stop-item', why: `#${target} already started ${total(target)} runs in ${LEDGER_DAYS} days`, target, items: [target] };
  if (target != null && issueCapped(target)) return { act: 'capped', why: `#${target} reached its daily cap (${ISSUE_CAP} runs)`, target };
  return { act: 'fire', why, target, via, sig, clearClaim: dead, work: work.map((w) => w.number) };
}

/** The fire URL must be a scheduled task's /fire endpoint, nothing else. */
export function fireUrlOk(url, base = process.env.WAKE_FIRE_BASE || 'https://api.anthropic.com') {
  const b = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${b}/v1/claude_code/routines/trig_[A-Za-z0-9]+/fire$`).test(String(url || ''));
}

/** The text the run receives (inside its fire-payload block): a hint; the run acts on what GitHub shows. */
export function payload({ repo, why, target, stateIssue, work = [] }) {
  return [`Coordinator wake for ${repo} (${why}).`,
    target != null ? `Woken by #${target}: https://github.com/${repo}/issues/${target}` : 'No single issue: read the queue and the board.',
    ...(work.length ? [`Stale work the backstop saw: ${work.map((n) => `#${n}`).join(' ')} (move each, or record why it waits).`] : []),
    `STATE: https://github.com/${repo}/issues/${stateIssue} (read it first, write it last).`,
    `Handle every open issue labelled \`${WAKE}\` (remove the label once handled), then remove \`${CLAIM}\` from #${stateIssue} as the very last step.`].join('\n');
}

// --- GitHub -----------------------------------------------------------------------------------------
async function gh(method, path, data) {
  const r = await fetch(`${process.env.GITHUB_API_URL || 'https://api.github.com'}${path}`, {
    method,
    headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'harness-wake',
      ...(process.env.GH_TOKEN ? { authorization: `Bearer ${process.env.GH_TOKEN}` } : {}), ...(data ? { 'content-type': 'application/json' } : {}) },
    body: data ? JSON.stringify(data) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (r.status < 200 || r.status > 299) throw new Error(`${method} ${path} answered ${r.status}: ${JSON.stringify(json).slice(0, 200)}`);
  return json;
}

async function pages(path, max = 20) {
  const out = [];
  for (let page = 1; page <= max; page++) {
    const l = await gh('GET', `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    out.push(...l);
    if (l.length < 100) break;
  }
  return out;
}

const names = (i) => (i.labels || []).map((l) => l.name ?? l);

/** The job's receipts in the whole repository, LEDGER_DAYS back, so no edit to the STATE issue changes
 *  a count. If the listing is cut off, the decision fails closed: no run starts on an unread count. */
async function receipts(repo, now = Date.now()) {
  const since = new Date(now - LEDGER_DAYS * DAY).toISOString();
  const max = 50, l = await pages(`/repos/${repo}/issues/comments?since=${since}&sort=created&direction=asc`, max);
  if (l.length >= max * 100) throw new Error(`more than ${max * 100} comments in ${LEDGER_DAYS} days: the receipts cannot all be read, so no run starts`);
  return ledger(l);
}

/** The STATE issue: the first open one this job opened with the marker; else the first closed one,
 *  reopened; else a new one. */
async function stateIssue(repo, { open = true } = {}) {
  const hit = (await pages(`/repos/${repo}/issues?state=all&creator=${encodeURIComponent(BOT)}&sort=created&direction=asc`)).filter(isState);
  const live = hit.find((i) => i.state === 'open') || hit[0];
  if (live && open && live.state !== 'open') return gh('PATCH', `/repos/${repo}/issues/${live.number}`, { state: 'open', labels: [...new Set([...names(live), STATE])] });
  if (live || !open) return live || null;
  return gh('POST', `/repos/${repo}/issues`, { title: 'Coordinator state', labels: [STATE],
    body: `${STATE_MARK}\nThe coordinator's state (Harness Kit wake, K033). Each run reads this body first and writes it last (keep this first line). The label \`${CLAIM}\` here means a run is on. The comments below are the job's receipts.\n\nState: no run yet.\n` });
}

// Stale kinds a coordinator run can move. A draft (such as a wake channel) waits on purpose.
export const MOVABLE = (w) => w.kind !== 'draft';

/** Everything one decision reads. The claim is the label on any open issue, not only on STATE. */
async function read(repo, { issue, event }) {
  const st = await stateIssue(repo, { open: true });
  const led = await receipts(repo);
  const queue = (await pages(`/repos/${repo}/issues?state=open&labels=${WAKE}&sort=created&direction=asc`))
    .filter((i) => i.number !== st.number && !names(i).includes(STOPPED)).map((i) => i.number);
  const labelled = async (l) => (await pages(`/repos/${repo}/issues?state=open&labels=${l}`)).map((i) => i.number);
  const claimed = await labelled(CLAIM), stopped = new Set(await labelled(STOPPED));
  const pausedOn = await labelled(PAUSED), restingOn = await labelled(BACKSTOP_OFF);
  let it = null;
  if (issue) {
    const i = await gh('GET', `/repos/${repo}/issues/${issue}`);
    it = { number: i.number, open: i.state === 'open', labels: names(i), isState: i.number === st.number };
  }
  let work = [];
  if (event === 'schedule') {
    try { work = (await (await import('./stale.mjs')).scan(repo)).filter((w) => MOVABLE(w) && !stopped.has(w.number) && w.number !== st.number); }
    catch (e) { console.log(`wake: the stale scan failed (${e.message.slice(0, 120)}); counted as no stale work`); }
  }
  return { st, led, queue, it, work, claimed, claim: claimed.length > 0, pausedOn, restingOn, paused: pausedOn.length > 0, backstopOff: restingOn.length > 0 };
}

async function fire(url, token, text) {
  const r = await fetch(url, { method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'anthropic-beta': 'experimental-cc-routine-2026-04-01', 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ text }) });
  const t = await r.text();
  let j = null;
  try { j = JSON.parse(t); } catch { /* below */ }
  if (!r.ok) throw new Error(`the scheduled task did not start: ${r.status} ${String(t).slice(0, 160)}`);
  if (!j?.claude_code_session_url) throw new Error('the scheduled task answered without a session link');
  return j.claude_code_session_url;
}

const comment = (repo, n, body) => gh('POST', `/repos/${repo}/issues/${n}/comments`, { body });
const unclaim = (repo, n) => gh('DELETE', `/repos/${repo}/issues/${n}/labels/${CLAIM}`).catch(() => {});

async function runFire(repo, { event, issue, label }) {
  if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('fire runs only in GitHub Actions (harness-wake.yml): its receipts must be the job\'s own');
  const url = process.env.WAKE_ROUTINE_URL, token = process.env.WAKE_ROUTINE_TOKEN;
  if (!fireUrlOk(url)) throw new Error('WAKE_ROUTINE_URL is not a scheduled task\'s /fire URL (.harness/wake.md "Setup")');
  if (!token) throw new Error('the WAKE_ROUTINE_TOKEN secret is missing (.harness/wake.md "Setup")');
  const s = await read(repo, { issue, event });
  const d = decide({ event, label, issue: s.it, claim: s.claim, paused: s.paused, backstopOff: s.backstopOff, ledger: s.led, queue: s.queue, work: s.work, now: Date.now(), cap: capFrom(process.env.WAKE_DAILY_CAP) });
  console.log(`wake: ${d.act}: ${d.why}`);
  const addLabel = (n, l) => gh('POST', `/repos/${repo}/issues/${n}/labels`, { labels: [l] });
  if (d.act === 'empty') {
    if (d.last) await addLabel(s.st.number, BACKSTOP_OFF);
    await comment(repo, s.st.number, `${EMPTY_MARK}\nBackstop: nothing to do (${d.n} of ${EMPTY_STOP} empty in a row).${d.last ? ` The backstop rests (\`${BACKSTOP_OFF}\`) until the next run re-arms it.` : ''}`);
    return;
  }
  if (d.act === 'stuck' || d.act === 'stop-item') {
    // stopped for good: only a person removing the label wakes for these again
    for (const n of d.items) {
      await addLabel(n, STOPPED);
      await gh('DELETE', `/repos/${repo}/issues/${n}/labels/${WAKE}`).catch(() => {});
      await comment(repo, n, `${CAPPED_MARK}\nNeeds a person: ${d.why}. The coordinator is no longer woken for this (\`${STOPPED}\`); remove that label to allow it again.`).catch(() => {});
    }
    await comment(repo, s.st.number, `${STUCK_MARK}${JSON.stringify({ sig: d.sig || '', items: d.items })} -->\nNeeds a person: ${d.why}. Stopped for good: ${d.items.map((n) => `#${n}`).join(' ')} (\`${STOPPED}\`).`);
    process.exitCode = 3;   // one red run: the exception the owner sees once
    return;
  }
  if (d.act === 'pause') {
    if (d.clearClaim) for (const n of s.claimed) await unclaim(repo, n);
    await addLabel(s.st.number, PAUSED);
    await comment(repo, s.st.number, `Needs a person: ${d.why}. Wakes are paused (\`${PAUSED}\`): no run starts until one is started by hand (Actions, harness-wake, Run workflow), which lifts the pause.`);
    process.exitCode = 3;
    return;
  }
  if (d.act === 'capped') {
    if (d.target != null && event === 'labeled') await comment(repo, d.target, `${CAPPED_MARK}\nNo coordinator run started: ${d.why}. The \`${WAKE}\` label stays, so a later run or the daily backstop picks this up.`);
    return;
  }
  if (d.act !== 'fire') return;
  if (d.clearClaim) { for (const n of s.claimed) await unclaim(repo, n); console.log('wake: cleared a claim left by a run that died'); }
  // a run re-arms the backstop; a run started by hand also lifts a pause
  for (const n of s.restingOn) await gh('DELETE', `/repos/${repo}/issues/${n}/labels/${BACKSTOP_OFF}`).catch(() => {});
  if (d.via === 'hand') for (const n of s.pausedOn) await gh('DELETE', `/repos/${repo}/issues/${n}/labels/${PAUSED}`).catch(() => {});
  await gh('POST', `/repos/${repo}/issues/${s.st.number}/labels`, { labels: [CLAIM] });   // claim before the run exists
  // the receipt comes BEFORE the fire: every attempt is counted, and a run never starts uncounted
  await comment(repo, s.st.number, `${FIRE_MARK}${JSON.stringify({ issue: d.target, via: d.via, sig: d.sig })} -->\nStarting a run (${d.why}).`);
  let link;
  try { link = await fire(url, token, payload({ repo, why: d.why, target: d.target, stateIssue: s.st.number, work: d.work })); }
  catch (e) {
    await unclaim(repo, s.st.number);
    await comment(repo, s.st.number, `${FAIL_MARK}\nNot started: ${e.message}.`).catch(() => {});
    if (d.target != null) await comment(repo, d.target, `No coordinator run started: ${e.message}. The \`${WAKE}\` label stays; the next event or the daily backstop tries again (after ${STUCK_STOP} failures in a row, only a run started by hand).`).catch(() => {});
    throw e;
  }
  await comment(repo, s.st.number, `Run started: ${link}`).catch(() => {});
  if (d.target != null) await comment(repo, d.target, `Coordinator run started: ${link}`).catch(() => {});
  console.log(`wake: fired: ${link}`);
}

const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };

async function main() {
  const [cmd] = argv;
  const repo = opt('--repo');
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('--repo owner/name is required');
  const issue = opt('--issue') ? Number(opt('--issue')) : null;
  if (issue !== null && !Number.isInteger(issue)) throw new Error('--issue must be a number');
  if (cmd === 'fire') return runFire(repo, { event: opt('--event'), issue, label: opt('--label') });
  if (cmd === 'status') {
    const st = await stateIssue(repo, { open: false });
    if (!st) { console.log(JSON.stringify({ state: null })); return; }
    const led = await receipts(repo);
    const now = Date.now(), lastFire = led.filter((e) => e.kind === 'fire').at(-1);
    const claimed = (await pages(`/repos/${repo}/issues?state=open&labels=${CLAIM}`)).map((i) => i.number);
    console.log(JSON.stringify({ state: st.number, claim: claimed, fires24h: led.filter((e) => e.kind === 'fire' && now - e.at < DAY).length,
      cap: capFrom(process.env.WAKE_DAILY_CAP), failStreak: failStreak(led),
      paused: (await pages(`/repos/${repo}/issues?state=open&labels=${PAUSED}`)).length > 0,
      backstopOff: (await pages(`/repos/${repo}/issues?state=open&labels=${BACKSTOP_OFF}`)).length > 0,
      stopped: (await pages(`/repos/${repo}/issues?state=open&labels=${STOPPED}`)).map((i) => i.number), emptyStreak: led.filter((e) => e.kind === 'empty' && (!lastFire || e.at > lastFire.at)).length,
      queue: (await pages(`/repos/${repo}/issues?state=open&labels=${WAKE}`)).filter((i) => i.number !== st.number).map((i) => i.number) }));
    return;
  }
  throw new Error('usage: wake.mjs fire|status  (see the header of this file)');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((e) => { console.error(`wake: ${e.message}`); process.exit(1); });
}
