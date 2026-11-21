#!/usr/bin/env node
// scope — how much of a project's own CI a change needs (K059, .harness/ci.md). No dependencies.
//
//   node .harness/tools/scope.mjs decide [--base <sha>] [--head <sha>] [--event <name>] [--workflow <file>]
//        in Actions: writes level=light|full, tier3=true|false and reason= to $GITHUB_OUTPUT and a line to
//        the step summary. With no --base it reads the pull request's base from the event.
//   node .harness/tools/scope.mjs gate     the required check's last job: RESULTS (toJSON(needs)) and LEVEL
//        must agree. Exit 1 = a needed job failed, was cancelled, or was skipped on a full run.
//
// The rule, in one place and tested (tools/test-scope.mjs):
//   - Anything but a pull request (a push to main, the nightly schedule, a run by hand) is full.
//   - A pull request is light only when every path it touches (both names of a rename) is a document
//     (DOCS below) and none is under a path the profile keeps full (`ci_scope.full`, else FULL_PATHS),
//     nor a page of a documentation site found in the checkout (SITE_CONFIGS).
//     Agent rules (AGENTS.md, CLAUDE.md, .harness/*.md) are documents here: no test reads them. They are
//     still tier 3 for review (tier3=true), which a workflow uses to call its reviewers.
//   - A workflow that has no nightly schedule never runs light: the nightly full run on the default branch
//     is the net under every light run, so without it everything runs on every pull request.
//   - Anything unknown, unreadable or empty is full. An error never makes a run lighter.

import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { glob, highRisk } from './review.mjs';
import { parseYaml } from './lib.mjs';

/** Documents: text no build or test reads. Markdown, and the named notice files; never .mdx, .txt or .rst
 *  in general (requirements.txt, CMakeLists.txt, a Sphinx page), images or data (a site may compile them). */
export const DOCS = /(^|\/)(LICEN[CS]E|NOTICE|CHANGELOG|README|CODEOWNERS|AUTHORS|CONTRIBUTING|SECURITY)(\.(md|txt|rst))?$|\.md$/i;
/** Where a document may still be content a build or a test reads, unless the profile names its own list. */
export const FULL_PATHS = ['src/**', 'app/**', 'pages/**', 'content/**', 'public/**', 'lib/**', 'supabase/**', 'packages/**',
  '**/test/**', '**/tests/**', '**/__tests__/**', '**/fixtures/**', '**/testdata/**', 'spec/**', 'e2e/**', 'cypress/**', 'playwright/**'];
/** A documentation site builds its pages: with one of these files present, its pages are never documents. */
export const SITE_CONFIGS = { docs: ['mkdocs.yml', 'mkdocs.yaml', 'docusaurus.config.js', 'docusaurus.config.ts', 'docusaurus.config.mjs', 'docs/conf.py', 'docs/.vitepress', '.vitepress'], root: ['_config.yml', 'book.toml', 'conf.py'] };
/** Which pages a documentation site in this checkout builds: 'root' (every Markdown file), 'docs' (docs/ and blog/) or null. */
export function docsSite(exists) {
  if (SITE_CONFIGS.root.some((f) => exists(f))) return 'root';
  return SITE_CONFIGS.docs.some((f) => exists(f)) ? 'docs' : null;
}

/** Whether a workflow file (its text) runs on a schedule: the nightly full run. */
export function hasNightly(text) {
  try {
    const on = parseYaml(String(text || '')).on;
    return !!(on && typeof on === 'object' && Array.isArray(on.schedule) && on.schedule.some((s) => s && s.cron));
  } catch { return false; }
}

/**
 * The decision. `files`: every changed path (null when it could not be read). `nightly`: the calling
 * workflow has a schedule. Returns { level, tier3, reason }.
 */
export function decide({ event, files, profile, nightly, site = null }) {
  const tier3 = Array.isArray(files) && highRisk(files, profile).length > 0;
  const full = (reason) => ({ level: 'full', tier3, reason });
  if (event !== 'pull_request') return full(`${event || 'unknown event'}: not a pull request, everything runs`);
  if (!Array.isArray(files)) return full('the changed files could not be read');
  if (!files.length) return full('no changed file found');
  if (!nightly) return full('this workflow has no nightly schedule, so every pull request runs everything');
  if (site === 'root') return full('a documentation site here builds every Markdown file');
  const keep = [...(Array.isArray(profile?.ci_scope?.full) ? profile.ci_scope.full : FULL_PATHS), ...(site === 'docs' ? ['docs/**', 'blog/**'] : [])].map(glob);
  const code = files.find((f) => !DOCS.test(f));
  if (code) return full(`${code} is not a document`);
  const kept = files.find((f) => keep.some((re) => re.test(f)));
  if (kept) return full(`${kept} is under a path that always runs everything`);
  return { level: 'light', tier3, reason: `documents only (${files.length} file${files.length === 1 ? '' : 's'})` };
}

/**
 * The required check's verdict from `toJSON(needs)`. The scope job must have succeeded with a known level;
 * every other job must have succeeded, or, on a light run only, been skipped. Returns a list of problems.
 */
export function gate(results, level) {
  const problems = [];
  if (!results || typeof results !== 'object') return ['the needed jobs could not be read'];
  if (level !== 'light' && level !== 'full') problems.push(`no scope level (${JSON.stringify(level ?? null)}): the scope job did not finish`);
  for (const [job, r] of Object.entries(results)) {
    const res = r?.result;
    if (res === 'success') continue;
    if (res === 'skipped' && level === 'light') continue;
    problems.push(`${job}: ${res || 'no result'}${res === 'skipped' ? ' on a full run' : ''}`);
  }
  return problems;
}

/** Changed paths between two commits, both names of a rename, or null when git cannot tell. */
export function changedFiles(base, head, cwd = process.cwd()) {
  try {
    const out = execFileSync('git', ['diff', '--name-only', '--no-renames', '-z', `${base}...${head}`], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\0').filter(Boolean);
  } catch { return null; }
}

function arg(name) { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; }

function main() {
  const cmd = process.argv[2];
  if (cmd === 'gate') {
    let results = null;
    try { results = JSON.parse(process.env.RESULTS || ''); } catch { /* reported below */ }
    const p = gate(results, process.env.LEVEL);
    if (p.length) { for (const x of p) console.log(`::error::${x}`); process.exit(1); }
    console.log(`scope gate: every needed job passed (${process.env.LEVEL} run)`);
    return;
  }
  if (cmd !== 'decide') { console.error('usage: scope.mjs decide [--base sha] [--head sha] [--event name] [--workflow file] | gate'); process.exit(2); }
  let ev = {};
  try { ev = process.env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')) : {}; } catch { /* full below */ }
  const event = arg('event') || process.env.GITHUB_EVENT_NAME;
  const base = arg('base') || ev.pull_request?.base?.sha;
  const head = arg('head') || 'HEAD';
  let profile = null;
  try { profile = JSON.parse(readFileSync('.harness/profile.json', 'utf8')); } catch { /* defaults */ }
  const wfFile = arg('workflow') || (process.env.GITHUB_WORKFLOW_REF ? `.github/workflows/${process.env.GITHUB_WORKFLOW_REF.replace(/@.*$/, '').split('/').pop()}` : '');
  const nightly = !!wfFile && existsSync(wfFile) && hasNightly(readFileSync(wfFile, 'utf8'));
  const files = event === 'pull_request' ? (base ? changedFiles(base, head) : null) : [];
  const d = decide({ event, files, profile, nightly, site: docsSite((f) => existsSync(f)) });
  const lines = [`level=${d.level}`, `tier3=${d.tier3}`, `reason=${d.reason.replace(/[\r\n]/g, ' ')}`];
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Checks for this change: **${d.level}** (${d.reason})${d.tier3 ? '; high-risk paths: reviewers run' : ''}\n`);
  console.log(lines.join('\n'));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
