#!/usr/bin/env node
// audit — the kit's structural audit of one project (card H2). No dependencies.
//
//   node .harness/tools/audit.mjs [<project root>] [options]
//     --profile <file>   the project profile (default <root>/.harness/profile.json)
//     --repo owner/name  read GitHub state (rulesets, CI runs, labels) through the REST API;
//                        GITHUB_TOKEN or GH_TOKEN is used when set. Without --repo, every rule that
//                        needs GitHub is UNKNOWN.
//     --json <file>      also write the results as JSON (the judgment review reads it)
//     --md <file>        also write the Markdown report
//     --strict           exit 1 when a rule is FAIL that is not FAIL in the baseline (for CI)
//     --baseline <file>  the accepted results (default <root>/.harness/audit-baseline.json, a
//                        project-owned copy of an earlier --json); without one, any FAIL fails
//
// Every rule in the kit gets exactly one result: PASS · FAIL · UNKNOWN · NOT APPLICABLE, each with
// evidence. Missing access, a missing profile or a rule this script cannot decide is UNKNOWN, never
// PASS. Rules whose Verify column is judgment-only are UNKNOWN here with "judgment review" as the
// evidence; `.harness/audit/judgment-review.md` settles them by sampling recent work.

import { readFileSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseYaml, triggers, gh, validateSchema, fileHash } from './lib.mjs';
import { scrub } from './scrub.mjs';

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const VALUED = ['--profile', '--repo', '--json', '--md', '--baseline'];
const root = resolve(argv.find((a, i) => !a.startsWith('--') && !VALUED.includes(argv[i - 1])) || '.');
const kitDir = resolve(dirname(fileURLToPath(import.meta.url)), '..'); // the .harness this script ships in
const repo = opt('--repo');

const PASS = 'PASS', FAIL = 'FAIL', UNKNOWN = 'UNKNOWN', NA = 'NOT APPLICABLE';
const has = (p) => existsSync(join(root, p));
const read = (p) => readFileSync(join(root, p), 'utf8');
const git = (...a) => { try { return execFileSync('git', ['-C', root, ...a], { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; } };
const lsFiles = git('ls-files');
const tracked = (lsFiles || '').split('\n').filter(Boolean);
// Rules that scan tracked files or history decide nothing without git: UNKNOWN, never PASS.
const NEEDS_GIT = new Set(['A02', 'A03', 'A06', 'A09', 'A10', 'A12', 'C02', 'C08', 'C09', 'C15', 'C17', 'O09', 'DB01', 'DB02', 'DB03', 'DB05', 'RJ01', 'RJ02', 'RJ04', 'SD03', 'HI02', 'PI03', 'PW02', 'BL03']);
const short = (s, n = 160) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// --- the kit's rule list, read from the kit's own layer files ------------------------------------
const layerFiles = ['core.md', 'owner-defaults.md', 'capabilities.md',
  ...readdirSync(join(kitDir, 'presets')).map((f) => `presets/${f}`), ...readdirSync(join(kitDir, 'adapters')).map((f) => `adapters/${f}`)];
const rules = [];
for (const f of layerFiles) for (const m of readFileSync(join(kitDir, f), 'utf8').matchAll(/^- \*\*([A-Z]{1,2}[0-9]{2}) ([^*]+)\*\*/gm)) rules.push({ id: m[1], title: m[2].replace(/\.$/, '') });

// --- the profile ------------------------------------------------------------------------------------
const profilePath = opt('--profile') ? resolve(opt('--profile')) : join(root, '.harness/profile.json');
let profile = null, profileErrors = [];
if (existsSync(profilePath)) {
  try { profile = JSON.parse(readFileSync(profilePath, 'utf8')); } catch (e) { profileErrors = [`not JSON: ${e.message}`]; }
  if (profile) profileErrors = validateSchema(JSON.parse(readFileSync(join(kitDir, 'profile.schema.json'), 'utf8')), profile);
}
if (profile && profileErrors.length) profile = null; // an invalid profile decides nothing (UNKNOWN)
const caps = new Set(profile?.capabilities || []);
const defaultBranch = profile?.branches?.default || (git('symbolic-ref', '--short', 'refs/remotes/origin/HEAD') || '').trim().replace(/^origin\//, '') || 'main';

// --- workflows ----------------------------------------------------------------------------------------
const workflows = tracked.filter((f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f)).map((file) => {
  const text = read(file);
  let wf = {};
  try { wf = parseYaml(text) || {}; } catch { wf = {}; }
  return { file, text, wf, on: triggers(wf), jobs: Object.entries(wf.jobs || {}).filter(([, j]) => j && typeof j === 'object') };
});
const wfText = workflows.map((w) => w.text).join('\n');
const settings = (() => { try { return JSON.parse(read('.claude/settings.json')); } catch { return null; } })();
const deny = settings?.permissions?.deny || [];

// --- GitHub ---------------------------------------------------------------------------------------------
const api = {};
async function load() {
  if (!repo) return;
  const [rs, labels, runs, issues, pulls, comments] = await Promise.all([
    gh(`/repos/${repo}/rulesets?includes_parents=true`),
    gh(`/repos/${repo}/labels?per_page=100`),
    gh(`/repos/${repo}/actions/runs?branch=${encodeURIComponent(defaultBranch)}&event=push&per_page=30`),
    gh(`/repos/${repo}/issues?state=open&per_page=100`),
    gh(`/repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=30`),
    gh(`/repos/${repo}/issues/comments?sort=updated&direction=desc&per_page=50`),
  ]);
  api.rulesets = rs; api.labels = labels; api.runs = runs; api.issues = issues; api.pulls = pulls; api.comments = comments;
  if (rs.status === 200 && Array.isArray(rs.data)) {
    api.rulesetDetails = await Promise.all(rs.data.filter((r) => r.target === 'branch').map((r) => gh(`/repos/${repo}/rulesets/${r.id}`)));
  }
}
const noAccess = (r) => `GitHub API ${r ? `answered ${r.status}` : 'not queried (no --repo)'}; missing access is UNKNOWN`;
const bypassUnknown = (b) => b?.unreadableBypass && [UNKNOWN, `ruleset ${b.names.join(', ')}: its bypass list is not readable with this token (needs ruleset admin read)`];

/** The active branch ruleset(s) covering the default branch, merged into one view. */
function branchRules() {
  if (!api.rulesetDetails) return null;
  if (api.rulesetDetails.some((r) => r.status !== 200)) return null; // a ruleset we cannot read may cover the branch
  const names = (l) => l.includes('~DEFAULT_BRANCH') || l.includes(`refs/heads/${defaultBranch}`) || l.includes('~ALL');
  const covering = api.rulesetDetails.map((r) => r.data).filter((r) => r.enforcement === 'active')
    .filter((r) => names(r.conditions?.ref_name?.include || []) && !(r.conditions?.ref_name?.exclude || []).some((e) => e === '~DEFAULT_BRANCH' || e === `refs/heads/${defaultBranch}`));
  // bypass_actors is returned only to callers who can edit rulesets: absent means unknown, not none
  if (covering.some((r) => !Array.isArray(r.bypass_actors))) return { unreadableBypass: true, names: covering.map((r) => r.name) };
  const rulesOf = (t) => covering.flatMap((r) => r.rules.filter((x) => x.type === t));
  return {
    names: covering.map((r) => r.name),
    pr: rulesOf('pull_request')[0],
    checks: rulesOf('required_status_checks').flatMap((x) => x.parameters.required_status_checks.map((c) => c.context)),
    bypass: covering.flatMap((r) => r.bypass_actors || []),
    nonFF: rulesOf('non_fast_forward').length > 0,
  };
}

// --- checks: id → () => [result, evidence] ----------------------------------------------------------------
const applies = {
  DB: 'database', AU: 'auth', PI: 'public-interface', DP: 'deployments', RJ: 'recurring-jobs', SD: 'sensitive-data', BL: 'bilingual', HI: 'host-infra',
};
function applicability(id) {
  const p = id.replace(/[0-9]+$/, '');
  const gate = applicabilityOf(id, p);
  if (gate && gate[0] === NA) return gate;
  if (lsFiles === null && NEEDS_GIT.has(id)) return [UNKNOWN, 'git ls-files failed (no repository, or not readable): this rule scans tracked files or history'];
  return gate;
}
function applicabilityOf(id, p) {
  if (applies[p]) {
    if (!profile) return [UNKNOWN, 'no valid profile, so capabilities are unknown'];
    return caps.has(applies[p]) ? null : [NA, `capability ${applies[p]} is not enabled in the profile`];
  }
  if (p === 'WA' || p === 'PW') {
    if (!profile) return [UNKNOWN, 'no valid profile, so the preset is unknown'];
    if (p === 'PW' && profile.preset !== 'public-website') return [NA, `preset is ${profile.preset}`];
    if (id === 'WA01' && !['web-app', 'public-website'].includes(profile.preset)) return [NA, `preset is ${profile.preset}`];
    if (id === 'WA02' && (profile.preset !== 'web-app' || !(profile.performance || []).length)) return [NA, 'no web-app speed targets in the profile'];
  }
  if (id === 'A03' && !has('.claude/agents') && !has('.claude/skills')) return [NA, 'no .claude/agents or .claude/skills'];
  if (id === 'A12' && !profile) return [UNKNOWN, 'no valid profile, so tier-3 paths are unknown'];
  return null;
}

const shellFiles = tracked.filter((f) => /\.(sh|bash)$/.test(f) || f.startsWith('.github/workflows/'));
const testFiles = tracked.filter((f) => /(^|\/)(tests?|__tests__|e2e)\/|\.(test|spec)\.[cm]?[jt]sx?$/.test(f));
const scheduled = workflows.filter((w) => w.on.includes('schedule'));
const commitLog = (n) => git('log', `-${n}`, '--format=%H%x1f%an%x1f%s%x1f%b%x1e') || '';

const checks = {
  // ---- adapter: loading and settings
  A01() {
    if (!has('CLAUDE.md')) return [FAIL, 'no CLAUDE.md'];
    const t = read('CLAUDE.md');
    const need = ['@.harness/core.md', '@.harness/owner-defaults.md', '@.harness/VERSION'];
    const missing = need.filter((i) => !new RegExp(`^${i.replace(/[.]/g, '\\.')}\\s*$`, 'm').test(t));
    if (missing.length) return [FAIL, `CLAUDE.md does not import ${missing.join(', ')}`];
    const absent = need.map((i) => i.slice(1)).filter((p) => !has(p));
    if (absent.length) return [FAIL, `imported but missing: ${absent.join(', ')}`];
    return [PASS, 'CLAUDE.md imports core, owner defaults and VERSION, and they exist (fresh-session and resume probes: judgment review)'];
  },
  A02() {
    const imports = has('CLAUDE.md') ? [...read('CLAUDE.md').matchAll(/^@(\S+)/gm)].map((m) => m[1]) : [];
    const lookup = imports.filter((p) => /^\.harness\/(catalogue|capabilities|presets|adapters|project-specific|audit|tools)/.test(p));
    if (lookup.length) return [FAIL, `CLAUDE.md imports lookup files: ${lookup.join(', ')}`];
    const ruleFiles = tracked.filter((f) => /^\.claude\/rules\/.+\.md$/.test(f) && !/README\.md$/.test(f));
    const noPaths = ruleFiles.filter((f) => !/^---[\s\S]*?\npaths:/m.test(read(f)));
    if (noPaths.length) return [FAIL, `rule files without paths: frontmatter: ${short(noPaths.join(', '))}`];
    return [PASS, `no lookup file imported; ${ruleFiles.length} path rule file(s), each with paths:`];
  },
  A03() {
    const agents = tracked.filter((f) => /^\.claude\/agents\/[^/]+\.md$/.test(f) && !/README\.md$/.test(f));
    const reviewers = agents.filter((f) => /review/i.test(f) || /^description:.*review/im.test(read(f)));
    if (!reviewers.length) return [NA, 'no review subagents'];
    const bad = [];
    for (const f of reviewers) {
      const fm = (read(f).match(/^---\n([\s\S]*?)\n---/) || [, ''])[1];
      const tools = (fm.match(/^tools:\s*(.*)$/m) || [])[1];
      if (!tools) bad.push(`${f}: no tools: line (inherits every tool)`);
      else if (/\b(Write|Edit|MultiEdit|NotebookEdit)\b/.test(tools)) bad.push(`${f}: has write tools (${tools})`);
      if (!/^model:\s*\S+/m.test(fm)) bad.push(`${f}: no model:`);
    }
    return bad.length ? [FAIL, short(bad.join('; '), 400)] : [PASS, `${reviewers.length} review subagent(s), read-only tools and a pinned model`];
  },
  A04() {
    if (!has('.harness/VERSION')) return [FAIL, 'no .harness/VERSION: the kit is not installed'];
    if (!has('.harness/kit.lock.json')) return [FAIL, '.harness/VERSION exists but no kit.lock.json records what was installed'];
    const lock = JSON.parse(read('.harness/kit.lock.json'));
    const v = read('.harness/VERSION').trim();
    if (lock.version !== v) return [FAIL, `VERSION says ${v}, lock says ${lock.version}`];
    const drift = Object.entries(lock.files).filter(([p, h]) => !has(p) || fileHash(join(root, p)) !== h).map(([p]) => p);
    return drift.length ? [FAIL, `kit-managed files changed or missing since install: ${short(drift.join(', '))}`]
      : [PASS, `kit ${v} at ${lock.commit.slice(0, 12)}; ${Object.keys(lock.files).length} managed files match the lock`];
  },
  A05() {
    if (!settings) return [FAIL, 'no readable .claude/settings.json'];
    const selfEdit = deny.some((d) => /^(Edit|Write)\(\.?\/?\.claude\/settings(\.local)?\.json\)$/.test(d));
    const admin = deny.some((d) => /--admin/.test(d));
    const miss = [!selfEdit && 'Edit(.claude/settings.json) not denied', !admin && 'admin merges not denied'].filter(Boolean);
    return miss.length ? [FAIL, miss.join('; ')] : [PASS, 'settings deny self-edits and admin merges'];
  },
  A06() {
    const w = tracked.filter((f) => /(^|\/)wait-for[^/]*\.(sh|mjs|js)$/.test(f));
    if (!w.length) return [FAIL, 'no watcher script (wait-for.*) tracked'];
    const selfTest = w.some((f) => /--self-test|self.?test/i.test(read(f)));
    return selfTest ? [PASS, `watcher ${w.join(', ')} with a self-test`] : [FAIL, `watcher ${w.join(', ')} has no self-test`];
  },
  A09() {
    const hits = [], justified = [];
    for (const f of shellFiles) {
      const ls = read(f).split('\n');
      ls.forEach((l, i) => {
        if (/^\s*#/.test(l)) return;
        // a comment within the 6 lines above that names the trap is a recorded, judged exception
        const why = ls.slice(Math.max(0, i - 6), i).some((x) => /^\s*#.*grep -c/.test(x));
        if (/\|\s*grep\s+(-[a-zA-Z]*c\b|--count)/.test(l)) (why ? justified : hits).push(`${f}:${i + 1} grep -c in a pipeline`);
        if (/\)\s*&&\s*echo\s+["']?OK/.test(l) && !/set -e/.test(l)) hits.push(`${f}:${i + 1} ") && echo OK" without set -e`);
      });
    }
    const note = justified.length ? `; ${justified.length} use(s) justified by an adjacent comment (${short(justified.join(', '), 120)})` : '';
    return hits.length ? [FAIL, short(hits.join('; '), 400) + note] : [PASS, `${shellFiles.length} shell and workflow files scanned; no unjustified trap${note}`];
  },
  A10() {
    const log = commitLog(200);
    if (!log) return [UNKNOWN, 'git history unreadable'];
    const commits = log.split('\x1e').filter((c) => c.trim());
    const bad = commits.filter((c) => /co-authored-by:[^\n]*(claude|anthropic)/i.test(c)).map((c) => c.trim().slice(0, 10));
    return bad.length ? [FAIL, `${bad.length} of the last ${commits.length} commits carry a Claude Co-authored-by trailer: ${bad.slice(0, 5).join(', ')}`]
      : [PASS, `none of the last ${commits.length} commits carry a Claude trailer`];
  },
  A11() {
    const b = branchRules();
    if (!b) return [UNKNOWN, noAccess(api.rulesets)];
    if (bypassUnknown(b)) return bypassUnknown(b);
    if (!b.names.length) return [FAIL, `no active ruleset covers ${defaultBranch}`];
    const problems = [];
    if (!b.pr) problems.push('no pull_request rule');
    else if (JSON.stringify(b.pr.parameters?.allowed_merge_methods || []) !== '["squash"]') problems.push(`merge methods ${JSON.stringify(b.pr.parameters?.allowed_merge_methods)}`);
    if (!b.checks.length) problems.push('no required status check');
    if (b.bypass.length) problems.push(`${b.bypass.length} bypass actor(s)`);
    const want = profile?.branches?.required_checks || [];
    const missing = want.filter((c) => !b.checks.includes(c));
    if (missing.length) problems.push(`profile's required checks not required: ${missing.join(', ')}`);
    return problems.length ? [FAIL, `ruleset ${b.names.join(', ')}: ${problems.join('; ')}`]
      : [PASS, `ruleset ${b.names.join(', ')}: PR only, squash only, no bypass, requires ${b.checks.join(', ')}`];
  },
  A12() {
    const guard = workflows.filter((w) => /Tier-3:\s*authorized/i.test(w.text));
    if (!guard.length) return [FAIL, 'no workflow checks for the "Tier-3: authorized by card" line'];
    const edited = guard.filter((w) => /types:[^\n]*edited|-\s*edited/.test(w.text));
    return edited.length ? [PASS, `guard in ${edited.map((w) => w.file).join(', ')}, triggered on edited`]
      : [FAIL, `guard in ${guard.map((w) => w.file).join(', ')} but not triggered on edited, so a body fix does not re-run it`];
  },
  A13() {
    const upd = workflows.find((w) => /harness\.mjs\s+update/.test(w.text));
    if (!upd) return [NA, 'no unattended maintenance workflow installed'];
    return /secrets\.HARNESS_TOKEN|create-github-app-token/.test(upd.text) ? [PASS, `${upd.file} opens PRs with a GitHub App or the HARNESS_TOKEN secret (an owner-created token); whether either is set: judgment review`]
      : [FAIL, `${upd.file} opens PRs without an App or owner-created token, so its checks may never run`];
  },

  // ---- core
  C02() {
    const tpl = tracked.filter((f) => /^\.github\/ISSUE_TEMPLATE\/.*card/i.test(f));
    if (!tpl.length) return [UNKNOWN, 'no card issue template found; cards may live elsewhere (judgment review)'];
    const t = tpl.map(read).join('\n');
    const need = ['Goal', 'Context', 'Acceptance', 'Done when', 'Blocked'];
    const miss = need.filter((n) => !new RegExp(n, 'i').test(t));
    return miss.length ? [FAIL, `${tpl.join(', ')} lacks ${miss.join(', ')}`] : [PASS, `${tpl.join(', ')} carries ${need.join(', ')}`];
  },
  C08() {
    const only = [], skip = [];
    for (const f of testFiles) {
      if (!/\.[cm]?[jt]sx?$/.test(f)) continue;
      read(f).split('\n').forEach((l, i) => {
        if (/^\s*\/\//.test(l)) return;
        if (/\b(it|test|describe)\.only\s*\(/.test(l)) only.push(`${f}:${i + 1}`);
        if (/\b(it|test|describe)\.skip\s*\(|\bx(it|describe)\s*\(/.test(l)) skip.push(`${f}:${i + 1}`);
      });
    }
    if (only.length) return [FAIL, `.only in ${short(only.join(', '))}`];
    if (skip.length) return [FAIL, `${skip.length} skipped test(s): ${short(skip.join(', '), 300)} (each needs a recorded reason; judgment review)`];
    return [PASS, `${testFiles.length} test files: no .only, .skip or x-prefixed test`];
  },
  C09() {
    const g = checks.A12();
    if (g[0] !== PASS) return g;
    const b = branchRules();
    if (!b || b.unreadableBypass) return [UNKNOWN, `guard exists; whether it is required: ${noAccess(api.rulesets)}`];
    const guardWf = workflows.find((w) => /Tier-3:\s*authorized/i.test(w.text));
    const jobNames = guardWf.jobs.flatMap(([k, j]) => [k, j.name].filter(Boolean));
    const required = b.checks.some((c) => jobNames.includes(c) || guardWf.wf.name === c);
    return required ? [PASS, `guard runs in ${guardWf.file}, which produces required check(s) ${b.checks.join(', ')}`]
      : [FAIL, `guard in ${guardWf.file} is not among required checks ${b.checks.join(', ')}`];
  },
  C11() {
    if (!api.labels) return [UNKNOWN, noAccess()];
    if (api.labels.status !== 200) return [UNKNOWN, noAccess(api.labels)];
    const sev = api.labels.data.map((l) => l.name).filter((n) => /blocker|major|minor/i.test(n));
    return sev.length >= 3 ? [PASS, `severity labels exist: ${sev.join(', ')} (use in releases: judgment review)`]
      : [FAIL, `no blocker/major/minor severity labels (found: ${sev.join(', ') || 'none'})`];
  },
  C12() {
    const b = branchRules();
    if (!b) return [UNKNOWN, noAccess(api.rulesets)];
    if (bypassUnknown(b)) return bypassUnknown(b);
    if (!b.names.length) return [FAIL, `no active ruleset covers ${defaultBranch}`];
    const ok = b.pr && b.checks.length && !b.bypass.length;
    return ok ? [PASS, `PR only, required ${b.checks.join(', ')}, no bypass actor (${b.names.join(', ')})`]
      : [FAIL, `ruleset ${b.names.join(', ')}: ${[!b.pr && 'PR not required', !b.checks.length && 'no required check', b.bypass.length && 'bypass actors'].filter(Boolean).join('; ')}`];
  },
  C13() {
    if (!api.runs) return [UNKNOWN, noAccess()];
    if (api.runs.status !== 200) return [UNKNOWN, noAccess(api.runs)];
    const done = api.runs.data.workflow_runs.filter((r) => r.status === 'completed');
    if (!done.length) return [UNKNOWN, `no completed push run on ${defaultBranch} in the last 30`];
    const head = done[0].head_sha;
    const atHead = done.filter((r) => r.head_sha === head);
    const red = atHead.filter((r) => !['success', 'skipped', 'neutral'].includes(r.conclusion));
    if (!red.length) return [PASS, `every completed push run on ${defaultBranch} at ${head.slice(0, 7)} succeeded (${atHead.map((r) => r.name).join(', ')})`];
    const fixIssue = api.issues?.status === 200 && api.issues.data.find((i) => i.labels.some((l) => /^(main|ci|default)-red$/i.test(l.name)) || /\b(main|master|default branch)\b[^\n]{0,20}\bred\b|\bred\b[^\n]{0,10}\b(main|master)\b/i.test(i.title));
    return fixIssue ? [PASS, `${red.map((r) => `${r.name} ${r.conclusion}`).join(', ')} at ${head.slice(0, 7)}; open fix issue #${fixIssue.number}`]
      : [FAIL, `${red.map((r) => `${r.name} ${r.conclusion} (${r.html_url})`).join(', ')} at ${head.slice(0, 7)} and no open fix issue`];
  },
  C15() {
    const s = scheduled.filter((w) => /stale|frozen|quiet/i.test(w.file + (w.wf.name || '')));
    if (!s.length) return [FAIL, 'no scheduled stale-work job'];
    const unbounded = s.filter((w) => w.jobs.some(([, j]) => !j['timeout-minutes'] && !j.uses));
    return unbounded.length ? [FAIL, `${unbounded.map((w) => w.file).join(', ')} has a job without timeout-minutes`] : [PASS, `scheduled ${s.map((w) => w.file).join(', ')} with timeouts`];
  },
  C17() {
    if (!profile) return [UNKNOWN, 'no valid profile, so canon files and caps are unknown'];
    const problems = [];
    for (const [f, max] of Object.entries(profile.canon.caps || {})) {
      if (!has(f)) { problems.push(`${f} missing`); continue; }
      const n = Buffer.byteLength(read(f));
      if (n > max) problems.push(`${f} ${n} B > cap ${max}`);
    }
    const d = profile.canon.decisions;
    if (!has(d)) problems.push(`decisions file ${d} missing`);
    else {
      const diff = git('log', '-50', '-p', '--format=%x1e%h', '--', d) || '';
      const removing = diff.split('\x1e').filter((c) => c.split('\n').some((l) => /^-[^-]/.test(l) && l.trim() !== '-')).map((c) => c.trim().slice(0, 7));
      if (removing.length) problems.push(`${d} lost lines in ${removing.length} of its recent commits (${removing.slice(0, 5).join(', ')}): append-only needs judgment`);
    }
    for (const g of profile.canon.generated || []) if (!has(g)) problems.push(`generated ${g} missing`);
    const drift = (profile.canon.generated || []).length && /git diff --exit-code|--check|drift/i.test(wfText);
    if ((profile.canon.generated || []).length && !drift) problems.push('no CI drift check for generated references found');
    return problems.length ? [FAIL, short(problems.join('; '), 500)] : [PASS, `caps hold (${Object.keys(profile.canon.caps || {}).length} files); ${d} only gained lines in its last 50 commits; generated references have a drift check`];
  },

  // ---- owner defaults
  O09() {
    const a = settings?.attribution;
    const off = a && a.commit === '' && a.pr === '';
    const log = commitLog(200);
    const gen = log.split('\x1e').filter((c) => /generated with \[?claude|co-authored-by:[^\n]*claude/i.test(c)).length;
    const problems = [];
    if (!off) problems.push('.claude/settings.json does not blank attribution.commit and attribution.pr');
    if (gen) problems.push(`${gen} of the last 200 commits carry Claude attribution`);
    if (!tracked.includes('.github/workflows/harness-scrub.yml')) problems.push('no harness-scrub.yml removes attribution from posted bodies (K006)');
    // behaviour: recent bodies posted after the scrubber was installed (it does not rewrite history)
    const since = (git('log', '--diff-filter=A', '--format=%cI', '-1', '--', '.github/workflows/harness-scrub.yml') || '').trim();
    const after = (x) => x.body && since && Date.parse(x.created_at) > Date.parse(since);
    const bodies = [...(api.pulls?.status === 200 ? api.pulls.data : []).filter(after).map((x) => [`PR #${x.number}`, x.body]),
      ...(api.issues?.status === 200 ? api.issues.data : []).filter((x) => after(x) && !x.pull_request).map((x) => [`issue #${x.number}`, x.body]),
      ...(api.comments?.status === 200 ? api.comments.data : []).filter(after).map((x) => [`comment on #${x.issue_url.split('/').pop()}`, x.body])];
    const left = bodies.filter(([, b]) => scrub(b) !== b).map(([w]) => w);
    if (left.length) problems.push(`${left.length} recent bodies still carry attribution: ${left.slice(0, 5).join(', ')}`);
    if (problems.length) return [FAIL, short(problems.join('; '), 400)];
    const allRead = [api.pulls, api.issues, api.comments].every((r) => r?.status === 200);
    if (!allRead) return [UNKNOWN, `settings, the last 200 commits and the scrubber hold; recent PR, issue and comment bodies not read (${noAccess([api.pulls, api.issues, api.comments].find((r) => r?.status !== 200))})`];
    return [PASS, `attribution blanked in settings; none in the last 200 commits; harness-scrub.yml installed; none left in ${bodies.length} PR, issue and comment bodies posted since it was`];
  },

  // ---- capabilities
  DB01() {
    const dir = ['supabase/migrations', 'db/migrations', 'migrations', 'prisma/migrations'].find(has);
    if (!dir) return [UNKNOWN, 'no migrations directory found'];
    const edits = (git('log', '-200', '--diff-filter=MD', '--name-only', '--format=%x1e%h %s', '--', dir) || '').split('\x1e').filter((c) => c.trim().includes('\n'));
    // a PR workflow that replays migrations itself, or runs a script that does
    const replayScripts = tracked.filter((f) => /\.(sh|mjs|js)$/.test(f) && /migration|replay/i.test(f) && /supabase (start|db reset)|createdb|initdb|pg_ctl|throwaway|replay|from scratch/i.test(read(f)));
    const replay = workflows.filter((w) => w.on.includes('pull_request') && (/replay|from scratch|db reset|supabase start/i.test(w.text) || replayScripts.some((f) => w.text.includes(f))));
    const problems = [];
    if (edits.length) problems.push(`${edits.length} recent commit(s) modified or deleted an existing migration: ${edits.slice(0, 3).map((c) => c.trim().split('\n')[0]).join(' | ')}`);
    if (!replay.length) problems.push('no pull_request workflow replays migrations on a throwaway database');
    return problems.length ? [FAIL, short(problems.join('; '), 400)] : [PASS, `no applied migration edited in recent history; replay in ${replay.map((w) => w.file).join(', ')}`];
  },
  DB02() {
    const gate = tracked.filter((f) => /migration[-_]?(gate|guard|class|consent)|classify[-_]?migration/i.test(f));
    const inCi = gate.filter((g) => wfText.includes(g.split('/').pop()));
    return inCi.length ? [PASS, `${inCi.join(', ')} classifies migrations in CI (applies match approvals: judgment review)`]
      : [FAIL, gate.length ? `${gate.join(', ')} exists but no workflow runs it` : 'no migration classifier script found'];
  },
  DB03() {
    // per job, by step order: the first step that applies migrations must follow a backup step
    const APPLY = /supabase db push|supabase migration up|migrate deploy|psql\b[^\n]*\s(-f|--file)\b/;
    const isApply = (st) => (/^(apply|push)\b|\bdb push\b/i.test(st.name || '') && /psql|supabase|migrate/.test(st.run || '')) || APPLY.test((st.run || '').split('\n').filter((l) => !/^\s*#/.test(l) && !/Bash\(/.test(l)).join('\n'));
    const isBackup = (st) => /pg_dump|backup/i.test(`${st.name || ''}\n${st.run || ''}`);
    const found = [], bad = [];
    for (const w of workflows) for (const [k, j] of w.jobs) {
      const steps = Array.isArray(j.steps) ? j.steps.filter((x) => x && typeof x === 'object') : [];
      const a = steps.findIndex(isApply);
      if (a < 0) continue;
      found.push(`${w.file}#${k}`);
      const b = steps.findIndex(isBackup);
      if (b < 0 || b > a) bad.push(`${w.file}#${k} step "${steps[a].name || a + 1}"`);
    }
    if (!found.length) return [UNKNOWN, 'no workflow step applies migrations; applies may be manual (judgment review)'];
    return bad.length ? [FAIL, `apply without a backup step before it: ${bad.join(', ')}`] : [PASS, `${found.join(', ')}: a backup step precedes the apply`];
  },
  DB05() {
    const gen = profile?.canon?.generated || [];
    if (!gen.length) return [FAIL, 'the profile names no generated schema reference'];
    const ci = workflows.filter((w) => gen.some((g) => w.text.includes(g)) && /git diff|--check|drift/i.test(w.text));
    return ci.length ? [PASS, `drift check on ${gen.join(', ')} in ${ci.map((w) => w.file).join(', ')}`] : [FAIL, `no workflow checks ${gen.join(', ')} against a fresh generation`];
  },
  RJ01() {
    const bad = [];
    for (const w of workflows) {
      for (const [k, j] of w.jobs) if (!j.uses && !j['timeout-minutes']) bad.push(`${w.file}#${k}`);
      if ((w.on.includes('schedule') || w.on.includes('workflow_run')) && !w.wf.concurrency && !w.jobs.every(([, j]) => j.concurrency)) bad.push(`${w.file} (scheduled or chained, no concurrency group)`);
    }
    return bad.length ? [FAIL, `${bad.length} unbounded: ${short(bad.join(', '), 400)}`] : [PASS, `${workflows.length} workflows: every job has timeout-minutes; scheduled and chained ones have concurrency`];
  },
  RJ02() {
    if (!scheduled.length) return [NA, 'no scheduled workflow'];
    const bad = scheduled.filter((w) => !/gh issue|issues\.(create|update)|\/issues/.test(w.text) && !tracked.some((f) => /\.(sh|mjs|js)$/.test(f) && w.text.includes(f) && /gh issue|\/issues/.test(read(f))));
    return bad.length ? [FAIL, `scheduled without a tracking-issue step: ${bad.map((w) => w.file).join(', ')}`] : [PASS, `${scheduled.length} scheduled workflow(s) report to an issue (one issue per job and stop-after-3: judgment review)`];
  },
  RJ04() {
    const bad = [];
    for (const w of workflows) {
      if (!w.wf.permissions && w.jobs.some(([, j]) => !j.permissions)) bad.push(`${w.file}: permissions not declared`);
      if ((w.on.includes('pull_request_target') || w.on.includes('workflow_run')) && /ref:\s*\$\{\{\s*github\.event\.(pull_request\.head|workflow_run\.head)/.test(w.text)) bad.push(`${w.file}: privileged trigger checks out the untrusted head`);
    }
    return bad.length ? [FAIL, short(bad.join('; '), 400)] : [PASS, `${workflows.length} workflows declare permissions; no privileged trigger checks out an untrusted head`];
  },
  SD03() {
    if (!settings) return [FAIL, 'no readable .claude/settings.json'];
    const envDeny = deny.some((d) => /^Read\(\.?\/?\.env\*?\)/.test(d));
    const envFiles = tracked.filter((f) => /(^|\/)\.env(\.|$)/.test(f) && !/\.example$|\.sample$|\.template$/.test(f));
    const problems = [!envDeny && 'settings do not deny Read(.env*)', envFiles.length && `tracked env files: ${envFiles.join(', ')}`].filter(Boolean);
    return problems.length ? [FAIL, problems.join('; ')] : [PASS, 'Read(.env*) denied; no env file tracked (client bundles: judgment review)'];
  },
  HI02() {
    // Loopback, RFC 1918, documentation ranges and public resolvers are not host details; version
    // strings (a part with a leading zero, or a fifth part) are not addresses.
    const benign = /^(10|127|0)\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|^192\.0\.2\.|^198\.51\.100\.|^203\.0\.113\.|^(1\.1\.1\.1|1\.0\.0\.1|8\.8\.8\.8|8\.8\.4\.4|9\.9\.9\.9|255\.255\.255\.\d+)$/;
    const ipAll = /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g;
    const conn = /\b(postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s:@/$]+:[^\s@/$]+@/;
    const hits = [], kinds = {};
    for (const f of tracked) {
      if (/\.(png|jpe?g|gif|webp|ico|woff2?|pdf|lock)$|package-lock\.json$/.test(f)) continue;
      let t; try { t = read(f); } catch { continue; }
      if (t.length > 2e6) continue;
      t.split('\n').forEach((l, i) => {
        for (const [a] of l.matchAll(ipAll)) {
          const parts = a.split('.');
          if (benign.test(a) || parts.some((n) => +n > 255 || /^0\d/.test(n)) || /version|pg_?dump|postgres \d/i.test(l)) continue;
          const kind = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a) ? 'CGNAT/tailnet' : 'public';
          kinds[kind] = (kinds[kind] || 0) + 1; hits.push(`${f}:${i + 1}`); break;
        }
        if (conn.test(l)) { kinds['connection string'] = (kinds['connection string'] || 0) + 1; hits.push(`${f}:${i + 1}`); }
      });
    }
    const files = [...new Set(hits.map((h) => h.split(':')[0]))];
    return hits.length ? [FAIL, `${hits.length} host-shaped line(s) (${Object.entries(kinds).map(([k, v]) => `${v} ${k}`).join(', ')}) in ${files.length} file(s), locations only: ${short(files.join(', '), 300)}`] : [PASS, `${tracked.length} tracked files: no public IP or credentialed connection string`];
  },
  PI03() {
    const secret = /(ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-[A-Za-z0-9]{32,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|xox[bap]-[A-Za-z0-9-]{20,}|[0-9]{8,10}:AA[A-Za-z0-9_-]{30,})/;
    const hits = tracked.filter((f) => { try { return !/\.(png|jpe?g|gif|webp|ico|woff2?|pdf)$/.test(f) && secret.test(read(f)); } catch { return false; } });
    return hits.length ? [FAIL, `secret-shaped strings in ${hits.join(', ')} (rotate; issues and PR bodies: judgment review)`] : [PASS, `${tracked.length} tracked files: nothing secret-shaped (issues and PR bodies: judgment review)`];
  },
  PW02() {
    const v = profile?.commands?.verify;
    if (!v) return [FAIL, 'the profile names no verify command'];
    const ci = workflows.filter((w) => w.on.includes('pull_request') && w.text.includes(v));
    if (!ci.length) return [FAIL, `no pull_request workflow runs ${v}`];
    const b = branchRules();
    if (!b || b.unreadableBypass) return [UNKNOWN, `${ci.map((w) => w.file).join(', ')} runs ${v}; whether it is required: ${noAccess(api.rulesets)}`];
    const names = ci.flatMap((w) => [w.wf.name, ...w.jobs.flatMap(([k, j]) => [k, j.name])]).filter(Boolean);
    return b.checks.some((c) => names.includes(c)) ? [PASS, `${v} runs in ${ci.map((w) => w.file).join(', ')}, part of required ${b.checks.join(', ')}`]
      : [FAIL, `${v} runs in ${ci.map((w) => w.file).join(', ')} but no required check comes from it`];
  },
  BL03() {
    const css = tracked.filter((f) => /\.(css|scss|astro|vue|svelte)$/.test(f));
    const phys = /\b(margin|padding|border)-(left|right)\s*:|\b(left|right)\s*:\s*[0-9]|text-align\s*:\s*(left|right)|float\s*:\s*(left|right)/;
    const hits = [];
    for (const f of css) read(f).split('\n').forEach((l, i) => { if (phys.test(l)) hits.push(`${f}:${i + 1}`); });
    return hits.length ? [FAIL, `${hits.length} physical direction properties: ${short(hits.join(', '), 300)}`] : [PASS, `${css.length} style files: logical properties only`];
  },
};

// --- run ---------------------------------------------------------------------------------------------------
await load();
const results = rules.map(({ id, title }) => {
  const gate = applicability(id);
  if (gate) return { id, title, result: gate[0], evidence: gate[1], how: 'applicability' };
  if (!checks[id]) return { id, title, result: UNKNOWN, evidence: 'judgment-only: settled by the judgment review', how: 'judgment' };
  try { const [result, evidence] = checks[id](); return { id, title, result, evidence, how: 'script' }; }
  catch (e) { return { id, title, result: UNKNOWN, evidence: `check could not run: ${e.message}`, how: 'script' }; }
});

const kitVersion = readFileSync(join(kitDir, 'VERSION'), 'utf8').trim();
const head = (git('rev-parse', 'HEAD') || '').trim();
const count = (r) => results.filter((x) => x.result === r).length;
const meta = {
  kit: kitVersion, project: profile?.project?.name || root.split('/').pop(), repo: repo || null, commit: head, when: new Date().toISOString(),
  profile: profile ? (profileErrors.length ? `invalid: ${profileErrors.slice(0, 5).join('; ')}` : 'valid') : 'missing',
  totals: { PASS: count(PASS), FAIL: count(FAIL), UNKNOWN: count(UNKNOWN), 'NOT APPLICABLE': count(NA) },
};
const md = [
  `# Structural audit · ${meta.project}`,
  '',
  `Kit ${meta.kit} · commit ${head.slice(0, 12) || 'unknown'} · ${meta.when} · profile ${meta.profile} · GitHub ${repo ? repo : 'not read'}`,
  '',
  `**${meta.totals.PASS} PASS · ${meta.totals.FAIL} FAIL · ${meta.totals.UNKNOWN} UNKNOWN · ${meta.totals['NOT APPLICABLE']} NOT APPLICABLE**`,
  '',
  '| ID | Rule | Result | Evidence |',
  '|---|---|---|---|',
  ...results.map((r) => `| ${r.id} | ${r.title} | ${r.result} | ${r.evidence.replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`),
  '',
].join('\n');

if (opt('--json')) writeFileSync(opt('--json'), JSON.stringify({ meta, results }, null, 2));
if (opt('--md')) writeFileSync(opt('--md'), md);
if (!opt('--json') && !opt('--md')) console.log(md);
console.log(`audit: ${meta.project} · ${Object.entries(meta.totals).map(([k, v]) => `${v} ${k}`).join(' · ')}`);
if (flags.has('--strict')) {
  const basePath = opt('--baseline') ? resolve(opt('--baseline')) : join(root, '.harness/audit-baseline.json');
  const accepted = new Set(existsSync(basePath) ? JSON.parse(readFileSync(basePath, 'utf8')).results.filter((r) => r.result === FAIL).map((r) => r.id) : []);
  const fresh = results.filter((r) => r.result === FAIL && !accepted.has(r.id));
  if (fresh.length) {
    for (const r of fresh) console.log(`audit: FAIL ${r.id} ${r.title}: ${r.evidence}`);
    process.exit(1);
  }
  if (accepted.size) console.log(`audit: no FAIL beyond the ${accepted.size} accepted in the baseline`);
}
