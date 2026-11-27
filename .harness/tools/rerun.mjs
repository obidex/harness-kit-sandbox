#!/usr/bin/env node
// rerun — one automatic re-run of a failed check that does not block the merge (K075). No dependencies.
//
//   node .harness/tools/rerun.mjs     in Actions (harness-rerun.yml), on the workflow_run event of a finished
//                                     pull-request workflow: starts that run's failed jobs once more when
//     - it failed on its first attempt, for a pull request from this repository (a fork's is left alone);
//     - none of its failed jobs is a required check of the pull request's base branch (its rulesets and
//       its branch protection); a required check's failure is the pull request's own business;
//     - no required check on the pull request's head has failed: they passed, or are still running.
//   Otherwise it says why on one line and writes nothing.
//
// Why: a check that is not required can fail on GitHub's own hiccup (a 502 on one read, roadmap #211),
// and the pull request then reads "a check failed" to whoever looks, with nothing wrong in the change.
// The kit's tools try each read three times (lib.mjs ghCall); this is the net under that: one re-run
// before anyone is told. A second failure stays red, as it should, and is never re-run again (attempt 2).
//
// Safe on untrusted input: the event is data; no code of the pull request is checked out or run, and the
// only write is GitHub's own re-run of a run that already ran. GITHUB_TOKEN reads the run's jobs, the base
// branch's rules and the head's checks, and starts the re-run (actions: write).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ghClient, ghPages } from './lib.mjs';

/** A check run's or job's conclusion that counts as failed. */
export const FAILED = new Set(['failure', 'timed_out', 'cancelled', 'startup_failure', 'action_required']);

/** The required check names of a branch, from GitHub's rules for it and its branch protection. */
export function requiredOf(rules, branch) {
  const out = new Set();
  for (const r of rules || []) if (r?.type === 'required_status_checks') for (const c of r.parameters?.required_status_checks || []) if (c?.context) out.add(c.context);
  const rc = branch?.protection?.required_status_checks;
  for (const c of rc?.contexts || []) out.add(c);
  for (const c of rc?.checks || []) if (c?.context) out.add(c.context);
  return out;
}

/** The newest state of each check on a commit: check runs by name (the newest id wins) and commit
 *  statuses by context (GitHub lists the newest first). Map name -> 'failed' | 'passed' | 'running'. */
export function checkStates(checkRuns, statuses) {
  const out = new Map(), newest = new Map();
  for (const c of checkRuns || []) if (!newest.has(c.name) || Number(c.id) > Number(newest.get(c.name).id)) newest.set(c.name, c);
  for (const [name, c] of newest) out.set(name, c.status !== 'completed' ? 'running' : FAILED.has(c.conclusion) ? 'failed' : 'passed');
  for (const s of statuses || []) if (!out.has(s.context)) out.set(s.context, s.state === 'pending' ? 'running' : s.state === 'success' ? 'passed' : 'failed');
  return out;
}

/**
 * Re-run or not, for one finished run. `run` is the event's workflow_run, `required` the base branch's
 * required check names, `jobs` the run's jobs, `states` the head's checks (checkStates). → { rerun, why }
 */
export function decide({ run, repo, required, jobs, states }) {
  if (run?.conclusion !== 'failure') return { rerun: false, why: `it ended ${run?.conclusion || 'without a conclusion'}, not failed` };
  if (Number(run.run_attempt) !== 1) return { rerun: false, why: `this was attempt ${run.run_attempt}: it was already run again once` };
  if (!String(run.event || '').startsWith('pull_request')) return { rerun: false, why: `it ran on ${run.event}, not for a pull request` };
  if (run.head_repository?.full_name !== repo) return { rerun: false, why: 'it ran for a fork\'s pull request' };
  const failed = (jobs || []).filter((j) => FAILED.has(j.conclusion)).map((j) => j.name);
  if (!failed.length) return { rerun: false, why: 'none of its jobs failed' };
  const req = failed.filter((n) => required.has(n));
  if (req.length) return { rerun: false, why: `its failed job ${req.join(', ')} is a required check: that failure blocks the merge and is the pull request's own` };
  const redRequired = [...required].filter((n) => states.get(n) === 'failed');
  if (redRequired.length) return { rerun: false, why: `the required check ${redRequired.join(', ')} failed on this head, so the pull request is red anyway` };
  return { rerun: true, why: `${failed.join(', ')} failed and ${failed.length === 1 ? 'is' : 'are'} not required; no required check failed (${[...required].map((n) => `${n}: ${states.get(n) || 'not started'}`).join(', ') || 'none required'})` };
}

const api = ghClient('harness-rerun', { token: () => process.env.GITHUB_TOKEN });

async function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const run = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')).workflow_run;
  if (!repo || !run) throw new Error('not a workflow_run event in Actions (GITHUB_REPOSITORY, GITHUB_EVENT_PATH)');
  const label = `${run.name} run ${run.id}`;
  // the cheap refusals first, before any read
  const early = decide({ run, repo, required: new Set(), jobs: [{ name: '?', conclusion: 'failure' }], states: new Map() });
  if (!early.rerun) { console.log(`rerun: ${label} left as it is: ${early.why}`); return; }
  let base = run.pull_requests?.[0]?.base?.ref;
  if (!base) {
    const [owner] = repo.split('/');
    base = (await api('GET', `/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${run.head_branch}`)}&per_page=1`))[0]?.base?.ref;
  }
  if (!base) { console.log(`rerun: ${label} left as it is: no open pull request for ${run.head_branch}`); return; }
  const rules = await api('GET', `/repos/${repo}/rules/branches/${encodeURIComponent(base)}?per_page=100`);
  const branch = await api('GET', `/repos/${repo}/branches/${encodeURIComponent(base)}`);
  const { items: jobs } = await ghPages(api, `/repos/${repo}/actions/runs/${run.id}/jobs?filter=latest`, { key: 'jobs', max: 3 });
  const { items: checkRuns } = await ghPages(api, `/repos/${repo}/commits/${run.head_sha}/check-runs`, { key: 'check_runs', max: 5 });
  const statuses = (await api('GET', `/repos/${repo}/commits/${run.head_sha}/status?per_page=100`))?.statuses || [];
  const d = decide({ run, repo, required: requiredOf(rules, branch), jobs, states: checkStates(checkRuns, statuses) });
  if (!d.rerun) { console.log(`rerun: ${label} left as it is: ${d.why}`); return; }
  try { await api('POST', `/repos/${repo}/actions/runs/${run.id}/rerun-failed-jobs`); }
  catch (e) {
    // already started again (by scrub after it removed a footer, K044) or still running: GitHub refuses a second
    // start, and that is not a failure of this job; any other refusal is reported the same way, once
    console.log(`::warning::rerun: ${label} was not started again: ${e.message.slice(0, 200)}`);
    return;
  }
  console.log(`rerun: started ${label}'s failed jobs once more (K075): ${d.why}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(`rerun: ${e.message}`); process.exit(1); });
}
