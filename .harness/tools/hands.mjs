#!/usr/bin/env node
// hands — repository settings as code, applied by the owner's one GitHub App (K007). No dependencies.
//
//   node .harness/tools/hands.mjs validate [root]           check root/.github/harness-settings.json (a PR check)
//   node .harness/tools/hands.mjs discover                  the App's repositories and what each enrolled
//   node .harness/tools/hands.mjs drift [--only owner/name] the enrolled repositories whose live settings differ
//                                                           from their file (JSON on stdout); read-only
//   node .harness/tools/hands.mjs plan  --repo owner/name   what applying the repo's settings file would change
//   node .harness/tools/hands.mjs apply --repo owner/name   apply it; every write is printed as one line, then
//                                                           the live settings are read back and must match
//   node .harness/tools/hands.mjs export --repo owner/name  the live settings as a settings file (to enroll)
//   node .harness/tools/hands.mjs control-check [root]      the control repository's workflows keep the App key on main
//   node .harness/tools/hands.mjs keep [--only owner/name]  bring every open kit update PR that is behind its base up
//                                                           to date (K012); JSON {watched, updated} on stdout
//
// Only the control repository's reviewed workflows on its main branch run discover, plan and apply,
// with a token minted from the App for that job alone (GH_TOKEN). A project changes its settings by
// a pull request to .github/harness-settings.json; once merged, the next run applies it.
//
// HANDS_PAUSED (the control repository's Actions variable) lists repositories, comma or space
// separated, or `*`, whose settings are left alone: drift skips them and apply refuses them. It is the
// emergency stop (README "Emergency"): pause, repair by hand, bring the file back into agreement, unpause.
//
// The file names what it manages. Repository keys are set as given; rulesets are matched by name and
// replaced when they differ; labels are created or updated. Nothing unnamed is touched unless the
// file's prune says so.

import { readFileSync, existsSync, readdirSync, appendFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSchema, parseYaml, triggers, plainValueProblems } from './lib.mjs';

export const SETTINGS_PATH = '.github/harness-settings.json';
/** True when HANDS_PAUSED names the repository or is `*`. */
export const paused = (repo, list = process.env.HANDS_PAUSED || '') => list.split(/[\s,]+/).filter(Boolean).some((x) => x === '*' || x.toLowerCase() === repo.toLowerCase());

const kitDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const schema = () => JSON.parse(readFileSync(join(kitDir, 'settings.schema.json'), 'utf8'));

// --- comparing desired with live ------------------------------------------------------------------
/** True when every value the desired side names equals the live one (live may carry more). */
export function covers(live, want) {
  if (Array.isArray(want)) {
    if (!Array.isArray(live) || live.length !== want.length) return false;
    const key = (x) => (x && typeof x === 'object' ? x.type ?? x.context ?? x.name ?? (x.actor_id !== undefined ? `${x.actor_type}:${x.actor_id}` : JSON.stringify(x)) : JSON.stringify(x));
    const byKey = new Map(live.map((x) => [key(x), x]));
    return want.every((w) => byKey.has(key(w)) && covers(byKey.get(key(w)), w));
  }
  if (want && typeof want === 'object') return !!live && typeof live === 'object' && Object.entries(want).every(([k, v]) => covers(live[k], v));
  return live === want;
}

const RULESET_KEYS = ['name', 'target', 'enforcement', 'conditions', 'rules', 'bypass_actors'];
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
const color = (c) => String(c || '').replace(/^#/, '').toLowerCase();

/**
 * The writes that make live match desired. live = { repository, rulesets: [full ruleset], labels: [label] }.
 * Each step: { what, call: { method, path, body } }.
 */
export function plan(repo, desired, live) {
  const steps = [];
  const base = `/repos/${repo}`;
  const repoWant = desired.repository || {};
  const repoDiff = Object.fromEntries(Object.entries(repoWant).filter(([k, v]) => live.repository?.[k] !== v));
  if (Object.keys(repoDiff).length) {
    steps.push({ what: `repository: ${Object.entries(repoDiff).map(([k, v]) => `${k} ${JSON.stringify(live.repository?.[k])} → ${JSON.stringify(v)}`).join(', ')}`, call: { method: 'PATCH', path: base, body: repoDiff } });
  }
  if (desired.rulesets) {
    const liveByName = new Map((live.rulesets || []).map((r) => [r.name, r]));
    for (const want of desired.rulesets) {
      const named = pick(want, RULESET_KEYS); // compared as the file states it
      const have = liveByName.get(want.name);
      // a bypass list the file leaves out is kept as it is live; a new ruleset then has none
      const body = { bypass_actors: have?.bypass_actors ?? [], ...named };
      if (!have) steps.push({ what: `ruleset "${want.name}": create`, call: { method: 'POST', path: `${base}/rulesets`, body } });
      else if (!covers(have, named)) steps.push({ what: `ruleset "${want.name}": replace (differs from the file)`, call: { method: 'PUT', path: `${base}/rulesets/${have.id}`, body } });
    }
    if (desired.prune?.rulesets) {
      // only rulesets of a target the file manages (a branch-only file never deletes tag rulesets)
      const named = new Set(desired.rulesets.map((r) => r.name));
      const targets = new Set(desired.rulesets.map((r) => r.target));
      for (const r of live.rulesets || []) if (!named.has(r.name) && targets.has(r.target)) steps.push({ what: `ruleset "${r.name}": delete (not in the file; prune)`, call: { method: 'DELETE', path: `${base}/rulesets/${r.id}` } });
    }
  }
  if (desired.labels) {
    const liveByName = new Map((live.labels || []).map((l) => [l.name.toLowerCase(), l]));
    for (const want of desired.labels) {
      const have = liveByName.get(want.name.toLowerCase());
      const body = { name: want.name, color: color(want.color), description: want.description ?? '' };
      if (!have) steps.push({ what: `label "${want.name}": create`, call: { method: 'POST', path: `${base}/labels`, body } });
      else if (have.name !== want.name || color(have.color) !== body.color || (have.description || '') !== body.description) {
        steps.push({ what: `label "${want.name}": update`, call: { method: 'PATCH', path: `${base}/labels/${encodeURIComponent(have.name)}`, body: { new_name: want.name, color: body.color, description: body.description } } });
      }
    }
    if (desired.prune?.labels) {
      const named = new Set(desired.labels.map((l) => l.name.toLowerCase()));
      for (const l of live.labels || []) if (!named.has(l.name.toLowerCase())) steps.push({ what: `label "${l.name}": delete (not in the file; prune)`, call: { method: 'DELETE', path: `${base}/labels/${encodeURIComponent(l.name)}` } });
    }
  }
  return steps;
}

// --- checking a settings file before it merges ------------------------------------------------------
/** Errors in a settings file, judged against the repository it sits in (root). */
export function validate(settings, root) {
  const errors = validateSchema(schema(), settings);
  if (errors.length) return errors;
  errors.push(...unsafe(settings));
  // a required check that no pull_request job produces would block every merge
  const dir = join(root, '.github/workflows');
  const jobs = new Set();
  for (const f of existsSync(dir) ? readdirSync(dir).filter((x) => /\.ya?ml$/.test(x)) : []) {
    let wf = {};
    try { wf = parseYaml(readFileSync(join(dir, f), 'utf8')) || {}; } catch { continue; }
    if (!triggers(wf).some((t) => t === 'pull_request' || t === 'pull_request_target')) continue;
    for (const [id, job] of Object.entries(wf.jobs || {})) jobs.add(job?.name && !String(job.name).includes('${{') ? String(job.name) : id);
  }
  for (const rs of settings.rulesets || []) {
    for (const rule of rs.rules) {
      if (rule.type !== 'required_status_checks') continue;
      for (const c of rule.parameters?.required_status_checks || []) {
        if (!jobs.has(c.context)) errors.push(`ruleset "${rs.name}": required check "${c.context}" is not a job any pull_request workflow here runs, so no PR could merge`);
      }
    }
  }
  return errors;
}

/** Settings that would leave a repository unprotected; refused by validate and again by plan/apply. */
export function unsafe(settings) {
  const errors = [];
  const guarded = (settings.rulesets || []).some((r) => r.target === 'branch' && r.enforcement === 'active' && r.rules.some((x) => x.type === 'required_status_checks'));
  if (settings.repository?.allow_auto_merge && !guarded) errors.push('allow_auto_merge without an active branch ruleset requiring checks: auto-merge would merge at once');
  if (settings.prune?.rulesets && !(settings.rulesets || []).some((r) => r.target === 'branch' && r.enforcement === 'active')) errors.push('prune.rulesets with no active branch ruleset named: it would delete all branch protection');
  return errors;
}

// --- the control repository's own invariants (A14) -------------------------------------------------
/** Problems with control workflows: the App key reachable off main, or from an event others can cause. */
export function controlProblems(files) {
  const problems = [];
  for (const [f, text] of Object.entries(files)) {
    for (const p of plainValueProblems(text)) problems.push(`${f}: ${p}`); // GitHub would reject the file
    let wf = {};
    try { wf = parseYaml(text) || {}; } catch { problems.push(`${f}: unparsable`); continue; }
    const on = triggers(wf);
    const calledOnly = on.length === 1 && on[0] === 'workflow_call';
    const offEvent = on.filter((t) => !['schedule', 'workflow_dispatch', 'workflow_call'].includes(t));
    for (const [id, job] of Object.entries(wf.jobs || {})) {
      const env = typeof job?.environment === 'object' ? job?.environment?.name : job?.environment;
      // a job reaches the key through the environment, or by calling a workflow with the caller's secrets
      const keyed = String(env ?? '').trim() === 'hands' || (typeof job?.uses === 'string' && job.secrets !== undefined);
      if (!keyed) continue;
      if (offEvent.length) problems.push(`${f}: job ${id} can reach the App key on a repository event (${offEvent.join(', ')})`);
      if (!calledOnly && !/github\.ref\s*==\s*'refs\/heads\/main'/.test(String(job.if ?? ''))) problems.push(`${f}: job ${id} reaches the App key without the main-branch guard in its own if:`);
    }
  }
  return problems;
}

// --- keeping kit update PRs current (K012) --------------------------------------------------------
// Under a strict required-checks rule a PR goes "behind" when its base branch moves, and GitHub's
// auto-merge then waits forever: it never updates the branch itself. keep does, through the App, so
// the project's checks run again on the new head and auto-merge goes on.
export const KIT_BRANCH = /^harness\/kit-\d+\.\d+\.\d+$/;
/** Hours a kit update PR is kept current (HANDS_KEEP_HOURS, default 72); an older one is left to the stale-work check. */
export function keepHours(env = process.env) {
  const v = String(env.HANDS_KEEP_HOURS ?? '').trim();
  if (!v) return 72;
  if (!/^\d+(\.\d+)?$/.test(v)) throw new Error(`HANDS_KEEP_HOURS must be a number of hours, not "${v}"`);
  return Number(v);
}
/**
 * What keep does with one open PR. Left alone: 'not a kit update' (another branch, or from a fork),
 * 'not the App's' (opened by someone else), 'old' (open longer than `hours`). Watched: 'update' (behind
 * its base), 'wait' (GitHub has not worked out its state yet), 'conflicted', 'draft', 'current'.
 */
export function keepAction(pr, { now = Date.now(), hours = 72, bot } = {}) {
  if (!KIT_BRANCH.test(pr.head?.ref || '') || !pr.head?.repo || pr.head.repo.full_name !== pr.base?.repo?.full_name) return 'not a kit update';
  if (bot ? pr.user?.login !== bot : pr.user?.type !== 'Bot') return "not the App's";
  if ((now - Date.parse(pr.created_at)) / 3600000 > hours) return 'old';
  if (pr.draft) return 'draft';
  const st = pr.mergeable_state;
  if (st === 'behind') return 'update';
  if (st === 'dirty') return 'conflicted';
  if (st === undefined || st === null || st === 'unknown') return 'wait';
  return 'current';
}
export const watched = (action) => !['not a kit update', "not the App's", 'old'].includes(action);

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
/** One repository: every open kit update PR of the App's, each behind one updated. */
async function keepRepo(repo, opts, log) {
  let seen = 0, updated = 0;
  const open = [];
  for (let page = 1; page < 20; page++) {
    const l = await must('GET', `/repos/${repo}/pulls?state=open&per_page=100&page=${page}`);
    open.push(...l);
    if (l.length < 100) break;
  }
  for (const listed of open) {
    if (!watched(keepAction({ ...listed, mergeable_state: 'unknown' }, opts))) continue;
    // the list leaves out mergeable_state; GitHub works it out on the first read of the PR itself
    let pr = await must('GET', `/repos/${repo}/pulls/${listed.number}`);
    for (let i = 0; i < 4 && keepAction(pr, opts) === 'wait'; i++) { await sleep(opts.retryMs ?? 3000); pr = await must('GET', `/repos/${repo}/pulls/${listed.number}`); }
    const action = keepAction(pr, opts);
    if (!watched(action)) continue;
    seen++;
    if (action !== 'update') { log(`hands: ${repo}: #${pr.number} (${pr.head.ref}) is ${action === 'wait' ? 'still being checked by GitHub' : action}; nothing to do`); continue; }
    const r = await api('PUT', `/repos/${repo}/pulls/${pr.number}/update-branch`, { expected_head_sha: pr.head.sha });
    if (r.status !== 202) throw new Error(`${repo}: #${pr.number} is behind ${pr.base.ref}, but update-branch answered ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
    updated++;
    log(`hands: ${repo}: applied update-branch to #${pr.number} (${pr.head.ref}): it was behind ${pr.base.ref}; its checks run again and auto-merge goes on`);
  }
  return { seen, updated };
}

// --- GitHub ---------------------------------------------------------------------------------------
export async function api(method, path, body) {
  // the drift check holds a token that could write; the tool refuses to (K008)
  if (process.env.HANDS_READ_ONLY && method !== 'GET') throw new Error(`refused ${method} ${path}: HANDS_READ_ONLY is set`);
  const r = await fetch(`${process.env.GITHUB_API_URL || 'https://api.github.com'}${path}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'harness-hands',
      ...(process.env.GH_TOKEN ? { authorization: `Bearer ${process.env.GH_TOKEN}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: r.status, data };
}
const must = async (method, path, body) => {
  const r = await api(method, path, body);
  if (r.status < 200 || r.status > 299) throw new Error(`${method} ${path} answered ${r.status}: ${JSON.stringify(r.data).slice(0, 300)}`);
  return r.data;
};

async function liveState(repo) {
  const repository = await must('GET', `/repos/${repo}`);
  const list = await must('GET', `/repos/${repo}/rulesets?per_page=100`);
  const rulesets = await Promise.all(list.filter((r) => r.source_type !== 'Organization').map((r) => must('GET', `/repos/${repo}/rulesets/${r.id}`)));
  const labels = [];
  for (let page = 1; page < 20; page++) {
    const l = await must('GET', `/repos/${repo}/labels?per_page=100&page=${page}`);
    labels.push(...l);
    if (l.length < 100) break;
  }
  return { repository, rulesets, labels };
}

async function fileOnDefault(repo, path) {
  const r = await api('GET', `/repos/${repo}/contents/${path}`);
  if (r.status === 404) return null;
  if (r.status !== 200) throw new Error(`GET ${path} in ${repo} answered ${r.status}`);
  return Buffer.from(r.data.content, 'base64').toString('utf8');
}

/** The writes a settings file needs against the live repository; refuses an invalid or unsafe file. */
async function planRepo(repo, text) {
  if (text === null) throw new Error(`${repo}: no ${SETTINGS_PATH} on its default branch`);
  const desired = JSON.parse(text);
  const errors = validateSchema(schema(), desired);
  if (!errors.length) errors.push(...unsafe(desired));
  if (errors.length) throw new Error(`${repo}: ${SETTINGS_PATH} is invalid: ${errors.join('; ')}`);
  return plan(repo, desired, await liveState(repo));
}

/** The App's repositories that carry a settings file or a kit lock. */
async function discover() {
  const repos = [];
  for (let page = 1; page < 50; page++) {
    const r = await must('GET', `/installation/repositories?per_page=100&page=${page}`);
    repos.push(...r.repositories);
    if (r.repositories.length < 100) break;
  }
  const out = [];
  for (const r of repos.filter((x) => !x.archived)) {
    const [settings, kit] = await Promise.all([api('GET', `/repos/${r.full_name}/contents/${SETTINGS_PATH}`), api('GET', `/repos/${r.full_name}/contents/.harness/kit.lock.json`)]);
    if (settings.status === 200 || kit.status === 200) out.push({ repo: r.full_name, settings: settings.status === 200, kit: kit.status === 200 });
  }
  return out;
}

// --- commands -------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const summary = (line) => { if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`); };
const note = (line) => { console.error(line); summary(`- ${line.replace(/^hands: /, '')}`); };

async function main() {
  const [cmd] = argv;
  if (cmd === 'validate') {
    const root = resolve(argv[1] && !argv[1].startsWith('--') ? argv[1] : '.');
    if (!existsSync(join(root, SETTINGS_PATH))) { console.log(`hands: no ${SETTINGS_PATH}; nothing to check`); return; }
    let settings;
    try { settings = JSON.parse(readFileSync(join(root, SETTINGS_PATH), 'utf8')); } catch (e) { console.log(`hands: FAIL ${SETTINGS_PATH} is not JSON: ${e.message}`); process.exit(1); }
    const errors = validate(settings, root);
    for (const e of errors) console.log(`hands: FAIL ${e}`);
    if (errors.length) process.exit(1);
    console.log(`hands: ${SETTINGS_PATH} is valid (${(settings.rulesets || []).length} rulesets, ${(settings.labels || []).length} labels)`);
    return;
  }
  if (cmd === 'control-check') {
    const dir = join(resolve(argv[1] || '.'), '.github/workflows');
    const files = Object.fromEntries(readdirSync(dir).filter((x) => /\.ya?ml$/.test(x)).map((x) => [x, readFileSync(join(dir, x), 'utf8')]));
    const problems = controlProblems(files);
    for (const p of problems) console.log(`hands: FAIL ${p}`);
    if (problems.length) process.exit(1);
    console.log(`hands: ${Object.keys(files).length} control workflows keep the App key on main`);
    return;
  }
  if (cmd === 'discover') {
    console.log(JSON.stringify(await discover()));
    return;
  }
  if (cmd === 'keep') {
    // the App's own PRs only: SLUG is the App's slug from the token step
    const opts = { hours: keepHours(), bot: process.env.SLUG ? `${process.env.SLUG}[bot]` : undefined, retryMs: Number(process.env.HANDS_KEEP_RETRY_MS || 3000) };
    const only = opt('--only')?.toLowerCase();
    // every enrolled repository and the control repository itself (hands-update moves its pin too)
    const all = (await discover()).map((x) => x.repo);
    const self = process.env.GITHUB_REPOSITORY;
    if (self && !all.some((r) => r.toLowerCase() === self.toLowerCase())) all.push(self);
    const repos = all.filter((r) => !only || r.toLowerCase() === only);
    let total = 0, updated = 0, failed = 0;
    for (const repo of repos) {
      try { const r = await keepRepo(repo, opts, note); total += r.seen; updated += r.updated; } catch (e) { failed++; note(`hands: ${repo}: FAIL ${e.message}`); }
    }
    note(`hands: ${total} open kit update PR(s) watched, ${updated} brought up to date`);
    console.log(JSON.stringify({ watched: total + failed, updated }));
    if (failed) process.exitCode = 1;
    return;
  }
  if (cmd === 'drift') {
    // read-only: one job checks every enrolled repository, so an unchanged one costs no job of its own
    const only = opt('--only')?.toLowerCase();
    const out = [];
    let failed = 0;
    const enrolled = (await discover()).filter((x) => x.settings && (!only || x.repo.toLowerCase() === only));
    // a dispatch for a repository that is not enrolled must not pass as "applied"
    if (only && !enrolled.length) { note(`hands: FAIL ${opt('--only')}: not enrolled (no ${SETTINGS_PATH} on its default branch, or the App is not installed there)`); failed++; }
    for (const r of enrolled) {
      if (paused(r.repo)) { note(`hands: ${r.repo}: paused (HANDS_PAUSED); left alone`); continue; }
      try {
        const steps = await planRepo(r.repo, await fileOnDefault(r.repo, SETTINGS_PATH));
        if (!steps.length) { note(`hands: ${r.repo}: matches its settings file`); continue; }
        for (const st of steps) note(`hands: ${r.repo}: drift: ${st.what}`);
        out.push(r.repo);
      } catch (e) { failed++; note(`hands: ${r.repo}: FAIL ${e.message}`); }
    }
    console.log(JSON.stringify(out));
    if (failed) process.exitCode = 1;
    return;
  }
  const repo = opt('--repo');
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('--repo owner/name is required');
  if (cmd === 'export') {
    const live = await liveState(repo);
    const keys = Object.keys(schema().properties.repository.properties);
    const out = {
      repository: pick(live.repository, keys),
      rulesets: live.rulesets.filter((r) => r.target === 'branch').map((r) => pick(r, RULESET_KEYS)),
      labels: live.labels.map((l) => ({ name: l.name, color: l.color, ...(l.description ? { description: l.description } : {}) })),
    };
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  if (cmd === 'plan' || cmd === 'apply') {
    if (cmd === 'apply' && paused(repo)) { console.log(`hands: ${repo}: paused (HANDS_PAUSED); nothing applied`); summary(`- ${repo}: paused`); return; }
    const text = opt('--file') ? readFileSync(opt('--file'), 'utf8') : await fileOnDefault(repo, SETTINGS_PATH);
    if (text === null) { console.log(`hands: ${repo}: not enrolled (no ${SETTINGS_PATH} on its default branch)`); return; }
    const steps = await planRepo(repo, text);
    if (!steps.length) { console.log(`hands: ${repo}: matches its settings file`); summary(`- ${repo}: matches its settings file`); return; }
    for (const s of steps) {
      if (cmd === 'apply') await must(s.call.method, s.call.path, s.call.body);
      console.log(`hands: ${repo}: ${cmd === 'apply' ? 'applied' : 'would apply'} ${s.what}`);
      summary(`- ${repo}: ${cmd === 'apply' ? 'applied' : 'would apply'} ${s.what}`);
    }
    if (cmd === 'apply') {
      // read back: what GitHub now holds must match the file, or the run fails and alerts
      const left = await planRepo(repo, text);
      if (left.length) throw new Error(`${repo}: read back after apply still differs: ${left.map((x) => x.what).join('; ')}`);
      console.log(`hands: ${repo}: read back, live settings match the file`);
      summary(`- ${repo}: read back, live settings match the file`);
    }
    return;
  }
  throw new Error('usage: hands.mjs validate|discover|drift|keep|plan|apply|export|control-check  (see the header of this file)');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((e) => { console.error(`hands: ${e.message}`); process.exit(1); });
}
