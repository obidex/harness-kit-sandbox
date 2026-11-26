#!/usr/bin/env node
// wake — disposable, event-fired coordinator runs (K033, .harness/wake.md). No dependencies.
//
//   node .harness/tools/wake.mjs fire --repo owner/name --event <labeled|unlabeled|schedule|workflow_dispatch>
//        [--issue <n>] [--label <name>]
//                                         in Actions only (harness-wake.yml): decide whether this event
//                                         starts a fresh coordinator run, and if so fire the project's
//                                         scheduled task (WAKE_ROUTINE_URL, WAKE_ROUTINE_TOKEN) and post
//                                         the run's session link as the receipt; with WAKE_START=label
//                                         (K057) it calls nothing outside GitHub: the claim label it
//                                         sets is the start, and the task listens for that label
//   node .harness/tools/wake.mjs started --repo owner/name
//                                         for a run that a label started (K057): prints `WAKE-START: OK`
//                                         only when the job itself signalled this start (its receipt, the
//                                         claim on the STATE issue) and no run took it yet; OK writes one
//                                         "Run started" comment that spends the start (needs a token that
//                                         may comment); else `WAKE-START: REFUSED` and exit 4
//   node .harness/tools/wake.mjs status --repo owner/name
//                                         the state the next decision reads (JSON; reads only)
//   node .harness/tools/wake.mjs handoff --repo owner/name [--issue <n>] [--from owner/name] [--task <trig id>] [--dry]
//                                         in a session (K056, wake.md "Hand-off between projects"): the
//                                         sender finished something that repository's project waits on.
//                                         The same decision as the job's, read from that repository; its
//                                         last line is what the session obeys:
//                                           HANDOFF: START <trig id> …   the claim and the receipt are
//                                             written: call fire_trigger once with that id
//                                           HANDOFF: QUEUED …            no start now (a run is on, a cap, a
//                                             stop): the `wake` label is on the issue and waits
//                                         --task names the receiver's run task only while that repository
//                                         names none itself (.github/wake.json); its own file always wins
//                                           HANDOFF: NOTHING …           nothing there to start or to queue
//                                           HANDOFF: DRY …               --dry: what it would do; start nothing
//   node .harness/tools/wake.mjs handoff --repo owner/name [--issue <n>] --failed <why>
//                                         the fire_trigger call after a START failed (same --issue, within
//                                         30 minutes of that START): releases the claim,
//                                         marks the start failed and leaves the `wake` label on the issue
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
// - Caps: every attempt is a receipt comment by github-actions[bot] (or, for a hand-off, K056, by an
//   account that may write to the repository), posted BEFORE the fire and read
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
import { ghClient, ghPages } from './lib.mjs';

export const WAKE = 'wake';
export const CLAIM = 'coordinator-running';
export const STATE = 'coordinator-state';
export const STATE_MARK = '<!-- coordinator-state -->';
export const FIRE_MARK = '<!-- wake-fire ';            // + JSON + ' -->': a receipt, posted BEFORE the fire
export const FAIL_MARK = '<!-- wake-fail -->';         // the fire after the last receipt did not start
export const START_MARK = '<!-- wake-start-label -->';  // K057: the run was signalled by the claim label, not by /fire
export const HANDOFF_MARK = '<!-- wake-handoff ';      // + JSON + ' -->': a receipt a session wrote BEFORE it started a run from inside (K056)
export const HANDOFF_FAIL_MARK = '<!-- wake-handoff-fail -->';   // that start did not happen
export const BACKOFF_MARK = '<!-- wake-backoff -->';   // K064: the job's receipt is no start: a hand-off it had not read keeps the run (a note; no count reads it)
export const HANDOFF_RULE = 'K064';                    // in a hand-off receipt: its sender keeps a start against a late job receipt, and the job backs off
export const RUN_TASK_FILE = '.github/wake.json';     // in the receiving repository: { "runTask": "trig_…", "dailyCap": n }: its coordinator-run scheduled task, and its daily cap where lowered
export const EMPTY_MARK = '<!-- wake-backstop-empty -->';
export const STUCK_MARK = '<!-- wake-stuck ';          // + JSON + ' -->': the backstop stopped on no progress
export const CAPPED_MARK = '<!-- wake-capped -->';
export const STOPPED = 'wake-stopped';     // on an issue: the job stopped waking for it; only a person removes it
export const PAUSED = 'wake-paused';       // on the STATE issue: no run starts except by hand (failed starts, a chain)
export const BACKSTOP_OFF = 'backstop-off'; // on the STATE issue: the backstop rests; the next run removes it
export const BOT = 'github-actions[bot]';
export const DAILY_CAP = 48;         // runs per repository per 24 h, hard ceiling (8 until K051: a loop-stopper, not a throttle)
export const ISSUE_CAP = 12;         // runs per woken issue per 24 h (3 until K051)
export const ISSUE_TOTAL = 36;       // runs per woken issue in LEDGER_DAYS (three full days of ISSUE_CAP, as before), then the issue is stopped for good
export const CLAIM_TTL_H = 6;        // a claim older than this belongs to a run that died
export const EMPTY_STOP = 3;         // empty backstops in a row, then the backstop stops
export const STUCK_STOP = 3;         // backstop runs in a row for the same work, or failed fires in a row: stop
export const CHAIN_STOP = 8;         // hand-off runs in a row with no outside wake between, then pause
export const USED_MARK = '<!-- wake-start-used -->';   // K057: the run's own "started" comment; it spends the job's receipt
export const START_WINDOW_MIN = 15;  // K057: a label-started run works only within this long of the job's receipt
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

const json = (b, mark) => { try { const j = JSON.parse(b.slice(mark.length, b.indexOf(' -->'))); return j && typeof j === 'object' ? j : {}; } catch { return {}; } };
/** May this comment's author write to the repository? A hand-off receipt counts only then (K056): on a
 *  public repository anyone may comment, and a stranger's comment must neither use a cap up nor count as a failed start.
 *  K065: `author_association` is no write check. OWNER is the repository's owner; MEMBER (any member of the
 *  owning organization) and COLLABORATOR (an outside collaborator, read or triage included) count only when
 *  GitHub's permission endpoint gave them write, maintain or admin (`writers`, a set of logins: writersOf). */
const ASKED = ['MEMBER', 'COLLABORATOR'];   // the associations whose real permission is read (writersOf)
const byWriter = (c, writers) => c?.author_association === 'OWNER' || (ASKED.includes(c?.author_association) && !!writers?.has?.(c?.user?.login));

/** The job's own marker comments, from anywhere in the repository, oldest first:
 *  { kind: fire|fail|empty|stuck, at, issue, via, sig }. A comment a person posted never counts, except a
 *  hand-off's receipt and failed start (K056), and those only from an account that may write here: the
 *  owner, or a login in `writers` (K065; read with writersOf before, so this stays pure). */
export function ledger(comments, { writers = new Set() } = {}) {
  const out = [];
  for (const c of comments) {
    const b = String(c.body || ''), at = Date.parse(c.created_at);
    // a hand-off receipt (K056) is written by a session, under the account the project's sessions act as:
    // it counts when its author may write to the repository, and only then. Edited later, it still counts.
    if (b.startsWith(HANDOFF_MARK)) { if (byWriter(c, writers)) { const j = json(b, HANDOFF_MARK); out.push({ kind: 'fire', at, issue: Number.isInteger(j.issue) ? j.issue : null, via: 'handoff', sig: '', id: c.id ?? null, seen: Number.isInteger(j.seen) ? j.seen : null, rule: j.rule === HANDOFF_RULE ? HANDOFF_RULE : null }); } continue; }
    // a failed start names the receipt it released (K064): a released start keeps nothing against the job
    if (b.startsWith(HANDOFF_FAIL_MARK)) { if (byWriter(c, writers)) { const m = b.match(/<!-- released (\{.*?\}) -->/); let rel = null; try { rel = m ? JSON.parse(m[1]).id : null; } catch { /* none */ } out.push({ kind: 'fail', at, via: 'handoff', id: c.id ?? null, released: Number.isInteger(rel) ? rel : null }); } continue; }
    if (!byJob(c)) continue;
    // the job never edits its comments: an edited one is counted as a run, whatever it says now
    if (c.updated_at && Math.abs(Date.parse(c.updated_at) - at) > 5000) { out.push({ kind: 'fire', at, issue: null, via: 'edited', sig: '' }); continue; }
    if (b.startsWith(FIRE_MARK)) {
      const j = json(b, FIRE_MARK);
      out.push({ kind: 'fire', at, issue: Number.isInteger(j.issue) ? j.issue : null, via: String(j.via || ''), sig: String(j.sig || ''), id: c.id ?? null, seen: Number.isInteger(j.seen) ? j.seen : null });
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
  } else if (event === 'handoff') {
    // K056: another project finished something this one waits on. An outside wake, under every cap and stop.
    if (issue && (!issue.open || issue.isState)) return { act: 'none', why: 'not an open issue to hand over' };
    if (issue?.labels.includes(STOPPED)) return { act: 'none', why: `#${issue.number} is stopped (${STOPPED}); a person removes that label to wake for it again` };
    target = issue ? issue.number : null; why = 'hand-off from another project'; via = 'handoff';
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

/** K057: does this project start its run by the claim label alone (no /fire call)? Only that one word. */
export const startByLabel = (v) => String(v ?? '').toLowerCase() === 'label';   // case as the workflow's `==` reads it

/** K057: is a run that a label started one the job itself signalled? Only then may it work: the claim
 *  sits on the STATE issue, the job's newest receipt is a start no older than START_WINDOW_MIN with no
 *  failure after it, and no run has spent that receipt yet (`used`: the USED_MARK comments since it).
 *  A claim label set by anyone else, or set again after a run took the start, has no unspent receipt,
 *  so that run ends at once and the caps hold for work, whoever can set a label. A hand-off's receipt
 *  is no signal either: the session that wrote it starts that run itself; one that yielded to a job
 *  receipt beside it is passed over, so the job's start still works. */
export function startOk({ ledger: led = [], stateClaimed = false, used = 0, now = Date.now() }) {
  if (!stateClaimed) return { ok: false, why: `the STATE issue does not carry \`${CLAIM}\`` };
  const evs = led.filter((e) => e.kind === 'fire' || e.kind === 'fail');
  // a hand-off yielded (keepsStart, K056) to a job receipt it had not read when it decided (`seen`) and
  // that was written by the end of its settle time: it started nothing, so it neither is a start here
  // nor hides the job's. A job receipt it had read did not make it yield: it kept its start. A receipt
  // with no `seen` (a sender before 0.51.0) counts as kept: at worst a start stalls, never two runs.
  const jobs = evs.filter((e) => e.kind === 'fire' && e.via !== 'handoff');
  const hands = evs.filter((e) => e.kind === 'fire' && e.via === 'handoff');
  const yielded = (e) => e.kind === 'fire' && e.via === 'handoff' && e.seen != null
    && jobs.some((j) => j.id != null && j.id > e.seen && j.at <= e.at + HANDOFF_SETTLE_MS);
  // K064: a job receipt that backed off from a hand-off which kept its start is no start either, judged
  // from the receipts alone, so a run that asks before the job's back-off note lands is refused as well
  const backedOff = (e) => e.kind === 'fire' && e.via !== 'handoff' && hands.some((h) => jobBacksOff(h, e, led));
  const last = evs.filter((e) => !yielded(e) && !backedOff(e)).at(-1);
  if (!last || last.kind !== 'fire') return { ok: false, why: 'the job\'s newest receipt is not a start' };
  // a hand-off that kept its start: its claim fires the label trigger too, but it starts its own run (fire_trigger, K056)
  if (last.via === 'handoff') return { ok: false, why: 'the newest start is a hand-off, which starts its own run' };
  const min = Math.floor((now - last.at) / 60000);
  if (now - last.at > START_WINDOW_MIN * 60000) return { ok: false, why: `the job's newest start receipt is ${min} minutes old (more than ${START_WINDOW_MIN})` };
  if (used > 0) return { ok: false, why: 'a run already took the job\'s newest start (one start, one run)' };
  return { ok: true, why: `the job signalled this start ${min} minute(s) ago`, issue: last.issue, at: last.at };
}

/** May this comment's author write to the repository? An installed App (a Bot), the owner, or a member or
 *  collaborator whose real permission is write, maintain or admin (`writers`, K065). A stranger's comment on
 *  a public repository is not a record, nor is one by a member or collaborator who may only read or triage. */
export const writer = (c, writers) => c?.user?.type === 'Bot' || byWriter(c, writers);

/** The USED_MARK comments made at or after a receipt's time by an account that may write, oldest first.
 *  Such a comment can only refuse a run, and those accounts can pause wakes with a label anyway. */
export const usedSince = (comments, at, writers) => comments.filter((c) => writer(c, writers) && String(c.body || '').startsWith(USED_MARK) && Date.parse(c.created_at) >= at)
  .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id - b.id);

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
const gh = ghClient('harness-wake');
const pages = async (path) => (await ghPages(gh, path, { max: 20 })).items;

const names = (i) => (i.labels || []).map((l) => l.name ?? l);

/** May the permission endpoint's answer write (K065)? A built-in `role_name` decides (admin, maintain, write
 *  may; triage, read may not). A custom repository role carries its own name there, so for any other name
 *  (or none) its base role decides: `permission` admin or write, or `user.permissions` push, maintain or admin. Pure. */
export const WRITE_ROLES = ['admin', 'maintain', 'write'];
const BUILT_IN = [...WRITE_ROLES, 'triage', 'read'];
export const mayWrite = (p) => {
  if (BUILT_IN.includes(p?.role_name)) return WRITE_ROLES.includes(p.role_name);
  const u = p?.user?.permissions;
  return ['admin', 'write'].includes(p?.permission) || u?.push === true || u?.maintain === true || u?.admin === true;
};

/** The authors among these comments whose marks would count only with write access (a hand-off's
 *  receipt or failed start, a run's "started" record, by a member or collaborator), asked once each. */
export const askFor = (comments) => [...new Set(comments.filter((c) => ASKED.includes(c?.author_association) && c?.user?.type !== 'Bot' && c?.user?.login
  && [HANDOFF_MARK, HANDOFF_FAIL_MARK, USED_MARK].some((m) => String(c.body || '').startsWith(m))).map((c) => c.user.login))];

/** K065: the logins among these comments' authors that may really write to the repository, read from
 *  GitHub's collaborator permission endpoint once per author (and once per process). 404 (no such
 *  collaborator) is no writer; any other refusal throws, so no decision is made on an unread count. */
const asked = new Map();
export async function writersOf(repo, comments, call = gh) {
  const out = new Set();
  for (const login of askFor(comments)) {
    const key = `${repo}\n${login}`;
    if (!asked.has(key)) {
      let p = null;
      try { p = await call('GET', `/repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`); }
      catch (e) { if (e.status !== 404) throw new Error(`the write permission of ${login} could not be read (${String(e.message).slice(0, 120)}), so its marks cannot be counted and no decision is made`); }
      asked.set(key, mayWrite(p));
    }
    if (asked.get(key)) out.add(login);
  }
  return out;
}

/** The ledger of these comments, with each member's and collaborator's real permission read first. */
async function ledgerOf(repo, comments) { return ledger(comments, { writers: await writersOf(repo, comments) }); }

/** The job's receipts in the whole repository, LEDGER_DAYS back, so no edit to the STATE issue changes
 *  a count. If the listing is cut off, the decision fails closed: no run starts on an unread count. */
async function receipts(repo, now = Date.now()) { return ledgerOf(repo, await recentComments(repo, now)); }
async function recentComments(repo, now = Date.now()) {
  const since = new Date(now - LEDGER_DAYS * DAY).toISOString();
  const max = 200, { items, cut } = await ghPages(gh, `/repos/${repo}/issues/comments?since=${since}&sort=created&direction=asc`, { max });
  if (cut) throw new Error(`more than ${max * 100} comments in ${LEDGER_DAYS} days: the receipts cannot all be read, so no run starts`);
  return items;
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
  // K057: with WAKE_START=label the claim label is the start (the project's task has a GitHub trigger on
  // it), so there is no URL, no token and no call outside GitHub; any other value is the /fire call
  const byLabel = startByLabel(process.env.WAKE_START);
  const url = process.env.WAKE_ROUTINE_URL, token = process.env.WAKE_ROUTINE_TOKEN;
  if (!byLabel && !fireUrlOk(url)) throw new Error('WAKE_ROUTINE_URL is not a scheduled task\'s /fire URL (.harness/wake.md "Setup")');
  if (!byLabel && !token) throw new Error('the WAKE_ROUTINE_TOKEN secret is missing (.harness/wake.md "Setup")');
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
  // `seen`: the newest receipt this decision read, so a hand-off written after it is judged by one rule (K064)
  const seen = Math.max(0, ...s.led.filter((e) => e.kind === 'fire' && Number.isInteger(e.id)).map((e) => e.id));
  const receipt = () => comment(repo, s.st.number, `${FIRE_MARK}${JSON.stringify({ issue: d.target, via: d.via, sig: d.sig, seen })} -->\nStarting a run (${d.why}).`);
  // K064: a hand-off this decision did not read may have started its run already (jobBacksOff): then this
  // receipt is no start. The job touches no claim (it is that run's), starts nothing, and the wake waits for that run.
  const backedOff = async (mine) => {
    const me = { kind: 'fire', via: d.via, id: mine?.id ?? null, at: Date.parse(mine?.created_at), seen };
    let keeper = null, all = null, err = null;
    for (let i = 0; i < 3 && !all; i++) {
      try { all = await receipts(repo); } catch (e) { err = e; await new Promise((ok) => setTimeout(ok, Number(process.env.WAKE_REREAD_MS ?? 2000))); }
    }
    // the repository-wide listing failed: a hand-off writes its receipt on the STATE issue, so read that issue's
    // own comments (from an hour before this receipt) before giving up
    if (!all) {
      try { all = await ledgerOf(repo, await pages(`/repos/${repo}/issues/${s.st.number}/comments?since=${new Date((me.at || Date.now()) - HOUR).toISOString()}`)); }
      catch (e) { err = e; }
    }
    if (!all) {
      // fail closed: unread receipts may hide a hand-off that already started its run, so nothing starts here.
      // The receipt is marked failed (counted, and `started` refuses a run on it); the claim is left as it is,
      // since it may be that hand-off's run's; at worst a start waits (the wake label stays), never two runs
      const why = `the receipts could not be read back after this receipt (${String(err?.message).slice(0, 120)})`;
      await comment(repo, s.st.number, `${FAIL_MARK}\nNot started: ${why}.`).catch(() => {});
      if (d.target != null) await comment(repo, d.target, `No coordinator run started: ${why}. The \`${WAKE}\` label stays; the run that is on takes it, or, if none is, the next start once the claim is released or counts as dead (${CLAIM_TTL_H} hours).`).catch(() => {});
      throw new Error(why);
    }
    keeper = all.find((e) => jobBacksOff(e, me, all)) || null;
    if (!keeper) return false;
    await comment(repo, s.st.number, `${BACKOFF_MARK}\nNo run started by this receipt: a hand-off from another project${keeper.issue != null ? ` for #${keeper.issue}` : ''}, written before it and not read when this decision was made, keeps the run (K064). That run reads the \`${WAKE}\` queue; this receipt still counts in the caps.`).catch(() => {});
    if (d.target != null) await comment(repo, d.target, `No coordinator run started by this wake: a run another project started is on, and it reads the \`${WAKE}\` queue. The label stays.`).catch(() => {});
    console.log(`wake: backed off: a hand-off's start keeps the run (receipt ${keeper.id})`);
    return true;
  };
  if (byLabel) {
    // the receipt first, as always; then the claim, whose `labeled` event is what starts the task.
    // decide() starts a run only with no claim, or a dead one cleared above.
    if (await backedOff(await receipt())) return;
    // a claim still there would send no event, so it is cleared first; a hand-off that claimed after this
    // decision either yielded to this receipt or kept its start, and then the job backed off above (K064)
    await unclaim(repo, s.st.number);
    // a label refused, lost or not confirmed is a failed start: recorded, counted, and the issue is told
    let failed = null;
    try {
      const got = await gh('POST', `/repos/${repo}/issues/${s.st.number}/labels`, { labels: [CLAIM] });
      if (!(got || []).some((l) => (l?.name ?? l) === CLAIM)) failed = `GitHub did not confirm the \`${CLAIM}\` label on #${s.st.number}`;
    } catch (e) { failed = `the \`${CLAIM}\` label on #${s.st.number} was refused (${String(e.message).slice(0, 120)})`; }
    if (failed) {
      // the failure is recorded BEFORE the claim goes: had GitHub set the label after all, the run it
      // started reads this record and is refused (wake.mjs started), so no run works without a claim
      await comment(repo, s.st.number, `${FAIL_MARK}\nNot started: ${failed}.`).catch(() => {});
      await unclaim(repo, s.st.number);
      if (d.target != null) await comment(repo, d.target, `No coordinator run started: ${failed}. The \`${WAKE}\` label stays; the next event or the daily backstop tries again (after ${STUCK_STOP} failures in a row, only a run started by hand).`).catch(() => {});
      throw new Error(failed);
    }
    const how = `the label \`${CLAIM}\` on #${s.st.number} starts the project's scheduled task (its GitHub trigger "Issue: Labeled"); the run's first comment on #${s.st.number} shows it started`;
    await comment(repo, s.st.number, `${START_MARK}\nRun signalled: ${how}.${d.target != null ? ` Woken by #${d.target}.` : ''}`).catch(() => {});
    if (d.target != null) await comment(repo, d.target, `Coordinator run signalled: ${how}.`).catch(() => {});
    console.log(`wake: signalled by label on #${s.st.number}`);
    return;
  }
  await gh('POST', `/repos/${repo}/issues/${s.st.number}/labels`, { labels: [CLAIM] });   // claim before the run exists
  // the receipt comes BEFORE the fire: every attempt is counted, and a run never starts uncounted
  if (await backedOff(await receipt())) return;   // the claim stays: it is the hand-off's run's
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

/** The receiving repository's coordinator-run task, from RUN_TASK_FILE on its default branch. */
export function runTaskOf(text) {
  let j = null;
  try { j = JSON.parse(text); } catch { return null; }
  return /^trig_[A-Za-z0-9]+$/.test(String(j?.runTask || '')) ? j.runTask : null;
}

/** The receiving repository's daily cap as its file states it (`dailyCap`): lower only, as WAKE_DAILY_CAP. */
export function capOf(text) {
  try { return capFrom(JSON.parse(text)?.dailyCap); } catch { return DAILY_CAP; }
}

/** What a hand-off does with the decision. Pure.
 *  out: { say: START|QUEUED|NOTHING, why, claim (set it and write the receipt), label (set `wake` on the issue) } */
export function handoffPlan(d, { task, issue = null }) {
  const can = !!issue && issue.open && !issue.isState && !issue.labels.includes(STOPPED);   // an issue the label may wait on
  if (d.act === 'fire') {
    if (task) return { say: 'START', why: d.why, claim: true, label: false };
    return { say: can ? 'QUEUED' : 'NOTHING', why: `the repository names no coordinator-run task (${RUN_TASK_FILE}) and --task gave none`, claim: false, label: can };
  }
  // a stop is a person's to lift and the job's to set: a hand-off sets none and waits behind every one
  if (d.act === 'stop-item') return { say: 'NOTHING', why: d.why, claim: false, label: false };
  if (d.act === 'pause') return { say: can ? 'QUEUED' : 'NOTHING', why: `${d.why}: no start from inside either`, claim: false, label: can };
  return { say: can ? 'QUEUED' : 'NOTHING', why: d.why, claim: false, label: can };
}

export const HANDOFF_SETTLE_MS = 8000;   // the settle time: a job receipt written within this long after a hand-off's makes it yield (K056, K064)
// how long a hand-off waits after its receipt before it reads who else started: longer than the settle time,
// because GitHub gives a comment's time in whole seconds, so a receipt the rule counts inside the settle time
// can be written up to a second after it; the hand-off reads only once every such receipt exists (K064)
export const HANDOFF_READ_MS = HANDOFF_SETTLE_MS + 2000;
export const HANDOFF_RELEASE_MIN = 30;   // --failed releases only a start this recent

/** K064: the one rule for who keeps the start between a hand-off's receipt `h` and a job receipt `j`
 *  that did not read it when the job decided (`j.seen`, the newest receipt id the job read). The hand-off
 *  keeps it, and the job backs off, when the hand-off read the job's receipt itself (it decided after it,
 *  with no claim on yet) or the job's receipt came more than the settle time after the hand-off's (by
 *  then the hand-off has read the receipts and started its run). Otherwise the hand-off yields, as K056
 *  says. Pure, and judged from the receipts alone, so the job, the hand-off and `started` all agree.
 *  Receipts from before K064 (a job receipt without `seen`, a hand-off receipt without the rule) never
 *  back the job off: two such senders behave exactly as before. */
export function jobBacksOff(h, j, led = []) {
  if (h?.kind !== 'fire' || h.via !== 'handoff' || h.rule !== HANDOFF_RULE || h.id == null) return false;
  if (j?.kind !== 'fire' || j.via === 'handoff' || j.seen == null || j.id == null) return false;
  if (h.id <= j.seen) return false;   // the job read this hand-off's receipt: it judged with that start in view
  // a start the hand-off released (`--failed`) before the job's receipt was written keeps nothing: the job starts
  if (led.some((f) => f.kind === 'fail' && f.via === 'handoff' && f.released === h.id && f.id != null && f.id < j.id)) return false;
  return (h.seen != null && j.id <= h.seen) || j.at > h.at + HANDOFF_SETTLE_MS;
}

/** Two starts written at the same moment: who keeps it? Pure. `mine` is this hand-off's receipt id,
 *  `fires` the receipts written since its decision read them. A hand-off yields to a job receipt beside
 *  its own unless that job backs off (jobBacksOff, K064: the job's receipt came after its settle time);
 *  between hand-offs the earliest receipt keeps the start. */
export function keepsStart(mine, fires) {
  const near = fires.filter((f) => f.id !== mine);
  const me = fires.find((f) => f.id === mine);
  if (!me) return false;   // its own receipt cannot be read back: no start on an unread count
  if (near.some((f) => f.via !== 'handoff' && !jobBacksOff(me, f))) return false;
  return !near.some((f) => f.at < me.at || (f.at === me.at && Number(f.id) < Number(mine)));
}

/** The STATE issue a hand-off reads: the job's own; else, in a repository whose coordinator keeps one by
 *  hand, the oldest open issue labelled so. Never opened, reopened or written to find it. */
async function handoffState(repo) {
  const own = await stateIssue(repo, { open: false });
  if (own && own.state === 'open') return own;
  return (await pages(`/repos/${repo}/issues?state=open&labels=${STATE}&sort=created&direction=asc`)).filter((i) => !i.pull_request)[0] || null;
}

const SLUG = /^[\w.-]+\/[\w.-]+$/;

async function runHandoff(repo, { issue, from, failed, dry, task: given }) {
  const who = SLUG.test(String(from || '')) ? from : 'another project';
  const done = (say, why) => console.log(`HANDOFF: ${say} ${String(why).replace(/\s+/g, ' ').slice(0, 300)}`);
  const st = await handoffState(repo);
  if (!st) return done('NOTHING', `${repo} has no open coordinator state issue (label ${STATE}): nothing to read a claim or a cap from`);
  const led = await receipts(repo);
  let it = null;
  if (issue) {
    const i = await gh('GET', `/repos/${repo}/issues/${issue}`);
    it = { number: i.number, open: i.state === 'open', labels: names(i), isState: i.number === st.number };
  }
  const can = !!it && it.open && !it.isState && !it.labels.includes(STOPPED);
  const queueIt = async () => { if (can && !it.labels.includes(WAKE) && !dry) await gh('POST', `/repos/${repo}/issues/${it.number}/labels`, { labels: [WAKE] }); };
  if (failed !== undefined) {
    // the start being released is the newest hand-off receipt for this item (another sender's receipt, one
    // that yielded, may be newer), recent, not already marked failed, and with no run of the job after it
    // (a job receipt that backed off from this start, K064, is no run: the claim is still this start's)
    const last = led.filter((e) => e.kind === 'fire' && e.via === 'handoff' && (e.issue ?? null) === (it?.number ?? null)).at(-1);
    if (!last || Date.now() - last.at > HANDOFF_RELEASE_MIN * 60e3 || led.some((e) => e.at >= last.at && ((e.kind === 'fail' && e.via === 'handoff') || (e.kind === 'fire' && e.via !== 'handoff' && !jobBacksOff(last, e, led))))) return done('NOTHING', 'no hand-off start is open here: nothing released');
    if (!dry) {
      await unclaim(repo, st.number);
      await comment(repo, st.number, `${HANDOFF_FAIL_MARK}<!-- released ${JSON.stringify({ id: last.id })} -->\nNot started from inside (hand-off from ${who}): ${String(failed).replace(/\s+/g, ' ').slice(0, 160)}.`);
      await queueIt();
    }
    return done(can ? 'QUEUED' : 'NOTHING', `the start failed and is marked so${can ? `; \`${WAKE}\` stays on #${it.number} for the next start` : ''}`);
  }
  const labelled = async (l) => (await pages(`/repos/${repo}/issues?state=open&labels=${l}`)).map((i) => i.number);
  const claimed = await labelled(CLAIM), paused = (await labelled(PAUSED)).length > 0;
  const queue = (await pages(`/repos/${repo}/issues?state=open&labels=${WAKE}&sort=created&direction=asc`)).filter((i) => i.number !== st.number && !names(i).includes(STOPPED)).map((i) => i.number);
  // the receiver's own file: its run task, and its daily cap where it lowered one (WAKE_DAILY_CAP is an
  // Actions variable no session can read, so a repository that lowers it writes the same number here)
  let file = '';
  try { file = Buffer.from((await gh('GET', `/repos/${repo}/contents/${RUN_TASK_FILE}`)).content || '', 'base64').toString('utf8'); } catch { /* no file */ }
  const d = decide({ event: 'handoff', issue: it, claim: claimed.length > 0, paused, ledger: led, queue, now: Date.now(), cap: Math.min(capOf(file), capFrom(process.env.WAKE_DAILY_CAP)) });
  let task = null;
  if (d.act === 'fire') {
    task = runTaskOf(file);
    // the sender may name the task only while the receiver names none: the receiver's own word wins
    if (!task) task = runTaskOf(JSON.stringify({ runTask: given }));
  }
  const p = handoffPlan(d, { task, issue: it });
  if (p.label) await queueIt();
  if (!p.claim) return done(p.say, `${p.why}${p.label ? `; \`${WAKE}\` is on #${it.number}: the run that is on, or the next start, takes it` : ''}`);
  if (!dry) {
    if (d.clearClaim) for (const n of claimed) await unclaim(repo, n);
    await gh('POST', `/repos/${repo}/issues/${st.number}/labels`, { labels: [CLAIM] });   // claim before the run exists
    // the receipt comes BEFORE the start, as the job's does: no run starts uncounted
    const seen = new Set(led.filter((e) => e.kind === 'fire').map((e) => e.id));
    // `seen`: the newest receipt this decision read, so `started` (K057) judges its yield exactly as keepsStart does
    const seenMax = Math.max(0, ...[...seen].filter(Number.isInteger));
    // `rule`: this sender keeps its start against a job receipt that comes after its settle time, and that job backs off (K064)
    const mine = await comment(repo, st.number, `${HANDOFF_MARK}${JSON.stringify({ issue: d.target, via: 'handoff', from: who, seen: seenMax, rule: HANDOFF_RULE })} -->\nStarting a run from inside (hand-off from ${who}${d.target != null ? ` for #${d.target}` : ''}).`);
    // one run at a time, also when two starts are written at the same moment: wait, then read who else
    // wrote a receipt around this one. The loser starts nothing; its receipt stays counted and the claim
    // stays with the start that keeps it.
    await new Promise((r) => setTimeout(r, Number(process.env.HANDOFF_SETTLE_MS ?? HANDOFF_READ_MS)));
    const near = (await receipts(repo)).filter((e) => e.kind === 'fire' && e.id != null && !seen.has(e.id));   // every start written since this decision read the receipts
    if (!near.some((e) => e.id === mine?.id)) {
      // its own receipt does not count here (an account that may not write): no start, and no claim left behind
      if (!near.length) await unclaim(repo, st.number);   // the claim is its own only when no other start was written
      await queueIt();
      return done(can ? 'QUEUED' : 'NOTHING', `this account's receipt does not count in ${repo} (it may not write there), so it starts nothing`);
    }
    if (!keepsStart(mine?.id, near)) {
      await queueIt();
      return done(can ? 'QUEUED' : 'NOTHING', `another start was written at the same moment and keeps the run${can ? `; \`${WAKE}\` is on #${it.number} for it` : ''}`);
    }
  }
  if (dry) return done('DRY', `would START ${task} (${repo}${d.target != null ? ` #${d.target}` : ''}); nothing written, start nothing`);
  done('START', `${task} (${repo}${d.target != null ? ` #${d.target}` : ''}): call fire_trigger once with this id and no text (a task that starts a new thread refuses added text; the run reads its queue from the repository); if the call is refused, run handoff again with --failed "<the error>"`);
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
  if (cmd === 'handoff') return runHandoff(repo, { issue, from: opt('--from'), failed: argv.includes('--failed') ? String(opt('--failed') ?? '') : undefined, dry: argv.includes('--dry'), task: opt('--task') });
  if (cmd === 'started') {
    // The run obeys the first word of the line. OK is given once per receipt: this command spends the
    // start with one comment on the STATE issue, and the oldest such comment since the receipt wins.
    const st = await stateIssue(repo, { open: false });
    const refuse = (why) => { console.log(`WAKE-START: REFUSED — ${why}`); process.exitCode = 4; };
    if (!st) return refuse('there is no STATE issue');
    const all = await recentComments(repo), writers = await writersOf(repo, all);
    const led = ledger(all, { writers }), stateClaimed = st.state === 'open' && names(st).includes(CLAIM);
    // first which receipt is the start, then whether a run already spent that one
    const r0 = startOk({ ledger: led, stateClaimed });
    const r = r0.ok ? startOk({ ledger: led, stateClaimed, used: usedSince(all, r0.at, writers).length }) : r0;
    if (!r.ok) return refuse(r.why);
    let mine;
    try { mine = await gh('POST', `/repos/${repo}/issues/${st.number}/comments`, { body: `${USED_MARK}\nRun started (label start${r.issue != null ? `, woken by #${r.issue}` : ''}).` }); }
    catch (e) { return refuse(`the start could not be recorded on #${st.number} (${String(e.message).slice(0, 120)})`); }
    let mineWrites = false;
    try { mineWrites = !!mine?.id && writer(mine, await writersOf(repo, [mine])); } catch { /* unread: not a record that counts */ }
    if (!mineWrites) return refuse(`the start could not be recorded on #${st.number} by an account that may write`);
    // two runs racing: the older record wins. A listing that does not show this run's own comment yet
    // is read again; one that never shows it, and shows no other, is no reason to waste the start.
    let seen = [];
    for (let i = 0; i < 4; i++) {
      const now2 = await recentComments(repo);
      seen = usedSince(now2, r.at, await writersOf(repo, now2));
      if (seen.some((c) => c.id === mine.id)) break;
      await new Promise((ok) => setTimeout(ok, Number(process.env.WAKE_REREAD_MS ?? 1500)));
    }
    const first = [...seen.filter((c) => c.id !== mine.id), mine].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id - b.id)[0];
    if (first.id !== mine.id) return refuse('another run took this start first');
    console.log(`WAKE-START: OK — ${r.why}`);
    return;
  }
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
  throw new Error('usage: wake.mjs fire|started|status|handoff  (see the header of this file)');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((e) => { console.error(`wake: ${e.message}`); process.exit(1); });
}
