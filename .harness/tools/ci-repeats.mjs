#!/usr/bin/env node
// ci-repeats — where a repository's runner time goes, and how much of it tested nothing new (K078;
// definitions in .harness/metrics.md §4). No model call, no imports outside Node, only reads.
//
//   node .harness/tools/ci-repeats.mjs --repo owner/name [--repo …] [--days 7] [--now ISO] [--max-calls 1500] [--json|--md]
//        reads GitHub itself (GH_TOKEN; GITHUB_API_URL for a stand-in): the runs of the window day by day, then each
//        finished run's jobs, every attempt. One call per run: a busy week of six repositories is several thousand
//        calls, so --max-calls stops it early and names the result partial (GitHub's hourly limit is shared with
//        every other agent on the same account: a host that already reads the jobs hands them over instead).
//   node .harness/tools/ci-repeats.mjs --runs FILE --jobs FILE [--pulls FILE] [--days 7] [--now ISO] [--json|--md]
//        the same numbers from a host's own records (tab-separated, no header; a field never holds a tab):
//          runs: repo id attempt workflow event conclusion created updated head_sha tree pr head_branch author message
//          jobs: repo run_id attempt name runner started completed conclusion
//          pulls: repo number head_branch created closed   (links a run to its pull request when the run lacks it)
//        times are ISO 8601 or epoch seconds; pr is the pull request's number or -; message is the head commit's
//        first line (only its form is used: a merge of the base, a "(#N)" merge, never shown).
//
// Every job attempt is counted once, as runner minutes (completed - started), in exactly one cause:
//   same       content already tested: the same job had passed on it, or the same content was started before and
//              this is its restart (a re-run of a passed job; a pull request run again with neither its head nor
//              its base changed, after an edited title, an empty commit or a reopen, even when the edit cancelled
//              the first run; the default branch testing a tree its pull request already tested green)
//   retry      the same, but the earlier attempt failed: a retry of unchanged content
//   bot        a run on a bot's commit pushed on top of a person's pull request (generated files)
//   base       a run on a merge of the default branch into the pull request, or the same head again after
//              the default branch moved: a new combination
//   main       the default branch on content no run had tested: a new combination
//   change     a pull request's own new content
//   other      everything a change did not start (schedules, issues, comments, dispatches, workflow_run)
// A push to another branch is a change (or a repeat of one, by its tree); a merge queue's run is main.
// Avoidable = same + bot. "Cancelled" is a flag on any of them, never a cause of its own, so the causes add
// up to the total exactly. Ready to green: per pull request merged in the window, from the first run on its
// last own commit to the moment the newest run of each workflow on its merged head had finished green.
//
// First pass (K079, metrics.md §5): of the pull requests whose first run started in the window, the share whose first
// head with finished runs passed every workflow on its first attempt. A failed first pass carries one of four causes,
// taken in this order: infrastructure (no runner, timed out, could not start, a failure with no failed job), unreliable
// test (a re-run of the same attempt, or a later run of the same workflow on the same tree, passed with nothing
// changed), old finding under a new rule (a kit update branch, harness/kit-*, or a workflow that was already red on the
// default branch before the pull request's first run), product defect (the rest: fixed by a new commit). A head whose
// commit says it fails on purpose ("expected to fail", "deliberately failing", "[expect-fail]") is left out.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CAUSES = ['same', 'retry', 'bot', 'base', 'main', 'change', 'other'];
export const FIRST_CAUSES = ['product', 'flaky', 'infrastructure', 'old_rule'];
export const FIRST_CAUSE_NAMES = Object.freeze({ product: 'product defect', flaky: 'unreliable test', infrastructure: 'infrastructure', old_rule: 'old finding under a new rule' });
const ON_PURPOSE = /\[expect-fail\]|\bexpected to fail\b|\bdeliberately fail|\bfails on purpose\b/i;
const OK = new Set(['success', 'skipped', 'neutral']);
export const AVOIDABLE = ['same', 'bot'];
export const PR_EVENTS = new Set(['pull_request', 'pull_request_target']);
export const MAX_CALLS = 1500;
const DAY = 86400000;

const BASE_MERGE = /^Merge (?:remote-tracking )?branch '(?:origin\/)?([\w./-]+)'(?: of \S+)? into /;
const MERGED_PR = /\(#(\d{1,7})\)\s*$/;
export const isBot = (name) => /\[bot\]$|^github-actions$/i.test(String(name || ''));
/** A head commit that merges the default branch into a pull request's branch (git's own message). */
export const isBaseMerge = (message, base) => { const m = BASE_MERGE.exec(String(message || '')); return !!m && m[1] === base; };
/** The pull request a squash or merge commit on the default branch closed, from GitHub's "(#N)" ending. */
export const mergedPr = (message) => { const m = MERGED_PR.exec(String(message || '').split('\n')[0]); return m ? Number(m[1]) : null; };
const ms = (t) => { if (t === null || t === undefined || t === '' || t === '-') return NaN; return /^\d+$/.test(String(t)) ? Number(t) * 1000 : Date.parse(t); };
/** Runner minutes of one job attempt. A job GitHub cancelled while it waited has a start time but no runner: it
 *  held no machine, so it is 0 (the start GitHub records for it is when it was dropped from the queue). */
export const minutes = (j) => { if (!j.runner) return 0; const s = ms(j.started), e = ms(j.completed); return Number.isFinite(s) && Number.isFinite(e) && e > s ? (e - s) / 60000 : 0; };
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const k = s.length >> 1; return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; };
const pctl = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]; };

/** The default branch: given, or the branch most push runs were on. */
export function defaultBranch(runs) {
  const n = new Map();
  for (const r of runs) if (r.event === 'push' && r.head_branch) n.set(r.head_branch, (n.get(r.head_branch) || 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1])[0]?.[0] || 'main';
}

/** The project's own check: the pull-request workflow with the most runner minutes, the kit's own chores
 *  (harness-*, scrub) left out, since every project runs those beside its check. */
export function mainCheck(runs) {
  const w = new Map();
  for (const r of runs) if (PR_EVENTS.has(r.event) && !/^(harness-|hands-scrub$|scrub$)/.test(r.workflow)) for (const j of r.jobs || []) w.set(r.workflow, (w.get(r.workflow) || 0) + minutes(j));
  return [...w].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}

/** GitHub's run listing often leaves a run's pull request out: a pull request run takes the number of the pull
 *  request whose branch it ran on and that was open when it was made (a branch reused later belongs to the later one). */
export function linkPulls(runs, pulls = []) {
  for (const r of runs) {
    if (r.pr || !PR_EVENTS.has(r.event)) continue;
    const t = ms(r.created);
    const p = pulls.filter((x) => x.branch === r.head_branch && ms(x.created) <= t + 60000 && !(ms(x.closed) < t)).sort((a, b) => ms(b.created) - ms(a.created))[0];
    if (p) r.pr = p.number;
  }
  return runs;
}

/** The numbers of one repository from its runs (each with .jobs) over [start, end). Runs created before the
 *  window are used as history (what had already passed) but not counted. */
export function analyse(runs, { start, end, base = null, check = null, pulls = [] } = {}) {
  base = base || defaultBranch(runs);
  linkPulls(runs, pulls);
  const all = [...runs].sort((a, b) => ms(a.created) - ms(b.created) || a.id - b.id || (a.attempt || 1) - (b.attempt || 1));
  // the default branch's heads, by when each was first seen: a pull request run's base is the newest one before it
  const mainHeads = [];
  for (const r of all) if (r.event === 'push' && r.head_branch === base && !mainHeads.some((h) => h.sha === r.head_sha)) mainHeads.push({ sha: r.head_sha, at: ms(r.created) });
  const baseAt = (t) => { let k = -1; for (let i = 0; i < mainHeads.length && mainHeads[i].at <= t; i++) k = i; return k; };
  // per pull request: did a person's commit already run? (a bot's commit after that is a regeneration)
  const ownSeen = new Set(), treesSeen = new Map();
  // passed[key] = the earliest completion of a passing attempt; failed[key] likewise for a failing one
  const passed = new Map(), failed = new Map(), seen = new Set();
  const totals = Object.fromEntries(CAUSES.map((c) => [c, { minutes: 0, cancelled: 0, jobs: 0 }]));
  const byWorkflow = new Map(), byWhere = {};
  let jobsCounted = 0;
  const inWindow = (t) => t >= start && t < end;
  for (const r of all) {
    const pr = PR_EVENTS.has(r.event);
    const push = r.event === 'push' && r.head_branch === base;
    let kind = 'other';
    if (pr) {
      const key = r.pr ?? r.head_branch;
      const tree = r.tree || r.head_sha;
      if (isBaseMerge(r.message, base)) kind = 'base';
      else if (isBot(r.author) && ownSeen.has(key)) kind = 'bot';
      else {
        // the same head again on a base that moved since: a new combination. On the same base it stays a change
        // (a job of it that already ran is caught below as a restart)
        const b = baseAt(ms(r.created)), was = treesSeen.get(`${r.workflow}|${key}|${tree}`);
        if (was && !was.has(b)) kind = 'base'; else { kind = 'change'; if (!isBot(r.author)) ownSeen.add(key); }
      }
      const tk = `${r.workflow}|${key}|${tree}`;
      if (!treesSeen.has(tk)) treesSeen.set(tk, new Set());
      treesSeen.get(tk).add(baseAt(ms(r.created)));
    } else if (push) kind = 'main';
    else if (r.event === 'merge_group') kind = 'main';            // a merge queue tests the combination main will hold
    else if (r.event === 'push') kind = 'change';                 // a push to a branch: the change, or a repeat of it
    const tree = r.tree || r.head_sha;
    // what this run tests: a pull request run its head on the base of that moment; the default branch its tree
    const branchPush = r.event === 'push' && !push, queue = r.event === 'merge_group';
    const own = pr ? `pr:${tree}:${baseAt(ms(r.created))}` : (push || branchPush || queue) ? `tree:${tree}` : null;
    // what a passing attempt covers: a pull request run also covers its head tree for the default branch (sound: the
    // default branch only reaches the head's exact tree when the head already held the base it was tested on)
    const covers = pr ? [own, `tree:${tree}`] : (push || branchPush || queue) ? [own, `pr:${tree}:${baseAt(ms(r.created))}`] : [];
    const counted = inWindow(ms(r.created));
    // a job that a later attempt lists again with its first attempt's times (a re-run of the failed jobs only) ran once
    const once = new Set();
    const jobs = [...(r.jobs || [])].filter((j) => { const k = `${j.name}|${j.started}|${j.completed}`; if (once.has(k)) return false; once.add(k); return true; });
    for (const j of jobs.sort((a, b) => ms(a.started) - ms(b.started))) {
      const m = minutes(j), s = ms(j.started), c = ms(j.completed);
      const key = (k) => `${r.workflow}|${j.name}|${k}`;
      let cause = kind;
      if (own && Number.isFinite(s)) {
        if (passed.get(key(own)) <= s) cause = 'same'; else if (failed.get(key(own)) <= s) cause = 'retry'; else if (seen.has(key(own))) cause = 'same';
      }
      if (counted && m > 0) {
        const t = totals[cause]; t.minutes += m; t.jobs++; jobsCounted++;
        if (j.conclusion === 'cancelled') t.cancelled += m;
        const w = byWorkflow.get(r.workflow) || Object.fromEntries(CAUSES.map((x) => [x, 0]));
        w[cause] += m; byWorkflow.set(r.workflow, w);
        const e = push ? 'default branch' : pr ? 'pull request' : 'other';
        byWhere[e] = byWhere[e] || {}; byWhere[e][cause] = (byWhere[e][cause] || 0) + m;
      }
      // the same job on the same content already held a runner (whatever became of it): a later start is a restart,
      // such as an edited title cancelling a build. One that only waited and was dropped never ran: no restart.
      // only a passing job covers its tree for other runs; one that failed or was cancelled marks its own content only
      if (own && m > 0) for (const k of (j.conclusion === 'success' ? covers : [own])) seen.add(key(k));
      const map = j.conclusion === 'success' ? passed : (j.conclusion === 'failure' || j.conclusion === 'timed_out') ? failed : null;
      if (map && Number.isFinite(c)) for (const k of (map === passed ? covers : [own])) if (!(map.get(key(k)) <= c)) map.set(key(k), c);
    }
  }
  const total = CAUSES.reduce((s, c) => s + totals[c].minutes, 0);
  const avoidable = AVOIDABLE.reduce((s, c) => s + totals[c].minutes, 0);
  const cancelled = CAUSES.reduce((s, c) => s + totals[c].cancelled, 0);
  const ci = total - totals.other.minutes;

  // merged pull requests: ready to green, and runs of the main check per merged change
  const merges = new Map();
  for (const r of all) if (r.event === 'push' && r.head_branch === base) { const n = mergedPr(r.message); if (n && !merges.has(n)) merges.set(n, ms(r.created)); }
  const prRuns = new Map();
  for (const r of all) if (PR_EVENTS.has(r.event) && r.pr) { if (!prRuns.has(r.pr)) prRuns.set(r.pr, []); prRuns.get(r.pr).push(r); }
  const pickCheck = check || mainCheck(all);
  const greens = [], runsPer = [];
  let merged = 0;
  for (const [n, at] of merges) {
    if (!inWindow(at)) continue;
    merged++;
    const rs = (prRuns.get(n) || []).filter((r) => ms(r.created) <= at);
    const mainRuns = all.filter((r) => r.event === 'push' && r.head_branch === base && mergedPr(r.message) === n && r.workflow === pickCheck);
    if (pickCheck) runsPer.push(rs.filter((r) => r.workflow === pickCheck).length + mainRuns.length);
    if (!rs.length) continue;
    const head = rs.at(-1).head_sha;
    // the last own commit: the newest head that is neither a merge of the base nor a bot's regeneration
    const heads = [...new Map(rs.map((r) => [r.head_sha, r])).values()];
    const own = [...heads].reverse().find((r) => !isBaseMerge(r.message, base) && !isBot(r.author)) || heads[0];
    const ready = Math.min(...rs.filter((r) => r.head_sha === own.head_sha).map((r) => ms(r.created)));
    const onHead = rs.filter((r) => r.head_sha === head);
    const newest = new Map();
    for (const r of onHead) if (!newest.has(r.workflow) || ms(r.created) >= ms(newest.get(r.workflow).created)) newest.set(r.workflow, r);
    const fin = [...newest.values()];
    if (!fin.length || fin.some((r) => r.conclusion !== 'success' && r.conclusion !== 'skipped' && r.conclusion !== 'neutral')) continue;
    const green = Math.max(...fin.map((r) => ms(r.updated)));
    if (green >= ready && green <= at + 60000) greens.push((green - ready) / 60000);
  }
  const r1 = (x) => (x === null ? null : Math.round(x * 10) / 10);
  const days = (end - start) / DAY;
  const fp = firstPass(all, { start, end, base });
  const week = (x) => r1((x * 7) / days / 60);
  return {
    base, check: pickCheck, days: r1(days), jobs: jobsCounted,
    hours: { total: r1(total / 60), ci: r1(ci / 60), avoidable: r1(avoidable / 60), cancelled: r1(cancelled / 60), ...Object.fromEntries(CAUSES.map((c) => [c, r1(totals[c].minutes / 60)])) },
    minutes: { total: r1(total), ci: r1(ci), avoidable: r1(avoidable), cancelled: r1(cancelled), ...Object.fromEntries(CAUSES.map((c) => [c, r1(totals[c].minutes)])) },
    cancelledHours: Object.fromEntries(CAUSES.map((c) => [c, r1(totals[c].cancelled / 60)])),
    avoidablePerWeek: week(avoidable),
    repeatShare: ci > 0 ? r1((100 * (totals.same.minutes + totals.retry.minutes + totals.bot.minutes + totals.base.minutes)) / ci) : null,
    avoidableShare: ci > 0 ? r1((100 * avoidable) / ci) : null,
    merged, mergedPerDay: r1(merged / days),
    firstPass: fp,
    readyToGreen: { measured: greens.length, medianMinutes: r1(median(greens)), p90Minutes: r1(pctl(greens, 0.9)) },
    checkRunsPerMerge: { measured: runsPer.length, median: r1(median(runsPer)), mean: runsPer.length ? r1(runsPer.reduce((a, b) => a + b, 0) / runsPer.length) : null },
    byWhere: Object.fromEntries(Object.entries(byWhere).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).map(([c, x]) => [c, r1(x / 60)]))])),
    byWorkflow: Object.fromEntries([...byWorkflow].sort((a, b) => Object.values(b[1]).reduce((x, y) => x + y, 0) - Object.values(a[1]).reduce((x, y) => x + y, 0)).slice(0, 12)
      .map(([w, v]) => [w, Object.fromEntries(Object.entries(v).filter(([, x]) => x > 0).map(([k, x]) => [k, r1(x / 60)]))])),
  };
}

/** First pass with its causes (K079; header and metrics.md §5). `all`: the repository's runs (with jobs), sorted. */
export function firstPass(all, { start, end, base }) {
  const sorted = [...all].sort((a, b) => ms(a.created) - ms(b.created) || a.id - b.id);
  const byPr = new Map();
  for (const r of sorted) if (PR_EVENTS.has(r.event) && r.pr) { if (!byPr.has(r.pr)) byPr.set(r.pr, []); byPr.get(r.pr).push(r); }
  // the first attempt of a run failed when a job of attempt 1 failed; a run with no jobs read is judged by its conclusion
  const firstFailed = (r) => {
    const j1 = (r.jobs || []).filter((j) => (j.attempt || 1) === 1);
    if (j1.length) return j1.some((j) => j.conclusion === 'failure' || j.conclusion === 'timed_out' || j.conclusion === 'startup_failure');
    return (r.attempt || 1) === 1 && r.conclusion !== null && !OK.has(r.conclusion) && r.conclusion !== 'cancelled';
  };
  const out = { ready: 0, green: 0, rate: null, leftOut: 0, causes: Object.fromEntries(FIRST_CAUSES.map((c) => [c, 0])) };
  for (const [, runs] of byPr) {
    if (!(ms(runs[0].created) >= start && ms(runs[0].created) < end)) continue;
    // the first head whose runs all finished and were not cancelled (a head the next push cancelled is not judged)
    const heads = [...new Map(runs.map((r) => [r.head_sha, true])).keys()];
    let head = null, onHead = [];
    for (const h of heads) {
      const rs = runs.filter((r) => r.head_sha === h);
      const first = [...new Map(rs.map((r) => [r.workflow, r])).values()].map((r) => rs.find((x) => x.workflow === r.workflow));
      if (first.length && first.every((r) => r.conclusion !== null && r.conclusion !== 'cancelled')) { head = h; onHead = first; break; }
    }
    if (!head) continue;
    if (ON_PURPOSE.test(onHead[0].message || '')) { out.leftOut++; continue; }
    out.ready++;
    const failed = onHead.filter(firstFailed);
    if (!failed.length) { out.green++; continue; }
    const r = failed[0];
    const at = ms(runs[0].created);
    const jobsFailed = (r.jobs || []).filter((j) => (j.attempt || 1) === 1 && (j.conclusion === 'failure' || j.conclusion === 'timed_out' || j.conclusion === 'startup_failure'));
    const infra = ['timed_out', 'startup_failure'].includes(r.conclusion) || (r.jobs || []).length > 0 && (!jobsFailed.length || jobsFailed.some((j) => !j.runner || j.conclusion !== 'failure'));
    const tree = r.tree || r.head_sha;
    const rerunPassed = (r.jobs || []).some((j) => (j.attempt || 1) > 1 && j.conclusion === 'success') && (r.jobs || []).filter((j) => (j.attempt || 1) > 1).every((j) => OK.has(j.conclusion));
    const laterSame = sorted.some((x) => x !== r && x.workflow === r.workflow && (x.tree || x.head_sha) === tree && ms(x.created) > ms(r.created) && OK.has(x.conclusion) && !firstFailed(x));
    const mainBefore = sorted.filter((x) => x.event === 'push' && x.head_branch === base && x.workflow === r.workflow && ms(x.created) < at).pop();
    const old = /^harness\/kit-/.test(r.head_branch || '') || (mainBefore && mainBefore.conclusion === 'failure');
    const cause = infra ? 'infrastructure' : (rerunPassed || laterSame) ? 'flaky' : old ? 'old_rule' : 'product';
    out.causes[cause]++;
  }
  out.rate = out.ready ? Math.round((1000 * out.green) / out.ready) / 10 : null;
  return out;
}

// --- reading -----------------------------------------------------------------------------------------
const API = () => (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');
async function get(path, budget) {
  if (budget.left-- <= 0) throw Object.assign(new Error('call budget spent'), { budget: true });
  const tok = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const res = await fetch(`${API()}${path}`, { headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'harness-ci-repeats', ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`GET ${path.split('?')[0]}: HTTP ${res.status}`);
  return res.json();
}
const runOf = (repo, r) => ({ repo, id: r.id, attempt: r.run_attempt || 1, workflow: r.name || r.path, event: r.event, conclusion: r.conclusion, created: r.created_at, updated: r.updated_at,
  head_sha: r.head_sha, tree: r.head_commit?.tree_id || null, pr: r.pull_requests?.[0]?.number ?? null, head_branch: r.head_branch, author: r.head_commit?.author?.name || null,
  message: String(r.head_commit?.message || '').split('\n')[0].slice(0, 300), jobs: [] });
const jobOf = (j) => ({ name: j.name, attempt: j.run_attempt || 1, runner: j.runner_name || null, started: j.started_at, completed: j.completed_at, conclusion: j.conclusion });

/** Read one repository's runs and jobs from GitHub, history days before the window included. */
export async function readRepo(repo, { start, end, history = 2, budget = { left: MAX_CALLS } } = {}) {
  const partial = [];
  let base = null;
  try { base = (await get(`/repos/${repo}`, budget)).default_branch; } catch (e) { if (e.budget) partial.push('call budget'); }
  const runs = [], pulls = [];
  try {
    for (let p = 1; p <= 5; p++) {
      const list = await get(`/repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=100&page=${p}`, budget);
      pulls.push(...list.map((x) => ({ number: x.number, branch: x.head?.ref, created: x.created_at, closed: x.closed_at })));
      if (list.length < 100 || ms(list.at(-1).updated_at) < start - 7 * DAY) break;
    }
    for (let d = start - history * DAY; d < end; d += DAY) {
      const day = new Date(d).toISOString().slice(0, 10);
      for (let p = 1; p <= 10; p++) {
        const j = await get(`/repos/${repo}/actions/runs?created=${day}&per_page=100&page=${p}`, budget);
        runs.push(...(j.workflow_runs || []).map((r) => runOf(repo, r)));
        if ((j.workflow_runs || []).length < 100) break;
        if (p === 10) partial.push(`runs of ${day} (cut at 1000)`);
      }
    }
    for (const r of runs) {
      if (r.conclusion === null) continue;   // not finished: no job of it is counted yet
      if (ms(r.created) < start - DAY && r.event !== 'push') continue;   // older history: only the default branch's
      for (let p = 1; p <= 5; p++) {
        const j = await get(`/repos/${repo}/actions/runs/${r.id}/jobs?filter=all&per_page=100&page=${p}`, budget);
        r.jobs.push(...(j.jobs || []).map(jobOf));
        if ((j.jobs || []).length < 100) break;
        if (p === 5) partial.push(`jobs of run ${r.id} (cut at 500)`);
      }
    }
  } catch (e) { partial.push(e.budget ? 'call budget spent: later runs are not counted' : e.message); }
  return { runs, base, pulls, partial };
}

/** A host's tab-separated records → runs with their jobs, by repository. */
export function fromTsv(runsText, jobsText, pullsText = '') {
  const byRepo = new Map(), index = new Map();
  for (const line of String(runsText || '').split('\n')) {
    const f = line.split('\t'); if (f.length < 13 || !/^\d+$/.test(f[1])) continue;
    const [repo, id, attempt, workflow, event, conclusion, created, updated, head_sha, tree, pr, head_branch, author, ...msg] = f;
    const r = { repo, id: Number(id), attempt: Number(attempt) || 1, workflow, event, conclusion: conclusion === '-' ? null : conclusion, created, updated, head_sha, tree: tree === '-' ? null : tree,
      pr: /^\d+$/.test(pr) ? Number(pr) : null, head_branch, author: author === '-' ? null : author, message: msg.join(' '), jobs: [] };
    const k = `${repo}|${id}`, old = index.get(k);
    if (old && old.attempt >= r.attempt) continue;   // the newest attempt's row describes the run; jobs carry their own attempt
    if (old) byRepo.get(repo).splice(byRepo.get(repo).indexOf(old), 1, r); else { if (!byRepo.has(repo)) byRepo.set(repo, []); byRepo.get(repo).push(r); }
    index.set(k, r);
  }
  for (const line of String(jobsText || '').split('\n')) {
    const f = line.split('\t'); if (f.length < 8) continue;
    const [repo, runId, attempt, name, runner, started, completed, conclusion] = f;
    const r = index.get(`${repo}|${runId}`); if (!r) continue;
    r.jobs.push({ name, attempt: Number(attempt) || 1, runner: runner === '-' ? null : runner, started, completed, conclusion });
  }
  const pulls = new Map();
  for (const line of String(pullsText || '').split('\n')) {
    const f = line.split('\t'); if (f.length < 5 || !/^\d+$/.test(f[1])) continue;
    if (!pulls.has(f[0])) pulls.set(f[0], []);
    pulls.get(f[0]).push({ number: Number(f[1]), branch: f[2], created: f[3], closed: f[4] === '-' ? null : f[4] });
  }
  for (const [repo, runs] of byRepo) linkPulls(runs, pulls.get(repo) || []);
  return byRepo;
}

// --- output -----------------------------------------------------------------------------------------
const n1 = (x) => (x === null || x === undefined ? '?' : String(x));
/** Markdown, counts only (safe for a public page): no titles, names or messages. */
export function render(results, { days = 7 } = {}) {
  const lines = [
    '| Repository | Avoidable runner-hours a week | Ready to green (median; p90) | Check runs per merged change | Merged a day | Runner-hours: same · retry · bot · base · main · change · other | Cancelled hours (flag) | First pass (green of ready; the rest by cause: product · unreliable test · infrastructure · old finding) |',
    '|---|---|---|---|---|---|---|---|',
    ...results.map((m) => m.error ? `| ${m.repo} | ? | ? | ? | ? | ? | ? | ? |` : `| ${m.repo} | ${n1(m.avoidablePerWeek)} (${n1(m.avoidableShare)}% of CI) | ${m.readyToGreen.measured ? `${n1(m.readyToGreen.medianMinutes)} min; ${n1(m.readyToGreen.p90Minutes)} min (${m.readyToGreen.measured})` : '-'} | ${n1(m.checkRunsPerMerge.median)} (${m.check || '?'}) | ${n1(m.mergedPerDay)} | ${CAUSES.map((c) => n1(m.hours[c])).join(' · ')} | ${n1(m.hours.cancelled)} | ${m.firstPass?.ready ? `${n1(m.firstPass.rate)}% (${m.firstPass.green}/${m.firstPass.ready}); ${FIRST_CAUSES.map((c) => m.firstPass.causes[c]).join(' · ')}` : '-'} |`),
    '',
    `Last ${days} days. Causes and limits: the kit's \`.harness/metrics.md\` §4. Avoidable = same + bot. "?" means not read, never zero.`,
  ];
  const notes = results.flatMap((m) => [...(m.partial || []).map((p) => `${m.repo}: partial, ${p}`), ...(m.error ? [`${m.repo}: ${m.error}`] : [])]);
  if (notes.length) lines.push('', ...notes.map((x) => `- ${x.replace(/\|/g, '/')}`));
  return lines.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const all = (k) => args.flatMap((a, i) => (args[i - 1] === k ? [a] : []));
  const one = (k) => all(k)[0];
  const days = Number(one('--days') || 7);
  if (!(days > 0 && days <= 31)) { console.error('ci-repeats: --days is 1 to 31'); process.exit(2); }
  const end = one('--now') ? Date.parse(one('--now')) : Date.now();
  const start = end - days * DAY;
  const results = [];
  if (one('--runs')) {
    const text = (k) => (one(k) ? readFileSync(one(k), 'utf8') : '');
    const byRepo = fromTsv(text('--runs'), text('--jobs'), text('--pulls'));
    for (const [repo, runs] of byRepo) results.push({ repo, ...analyse(runs, { start, end }), partial: [] });
  } else {
    const repos = all('--repo');
    if (!repos.length || repos.some((r) => !/^[\w.-]+\/[\w.-]+$/.test(r))) { console.error('usage: ci-repeats.mjs --repo owner/name [--repo …] | --runs FILE --jobs FILE  [--days 7] [--now ISO] [--max-calls N] [--json]'); process.exit(2); }
    const budget = { left: Number(one('--max-calls') || MAX_CALLS) };
    for (const repo of repos) {
      try { const { runs, base, pulls, partial } = await readRepo(repo, { start, end, budget }); results.push({ repo, ...analyse(runs, { start, end, base, pulls }), partial }); }
      catch (e) { results.push({ repo, error: e.message, partial: [] }); }
    }
  }
  console.log(args.includes('--json') ? JSON.stringify(results, null, 2) : render(results, { days }));
  if (!results.length || results.every((m) => m.error)) process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(`ci-repeats: ${e.message}`); process.exit(1); });
