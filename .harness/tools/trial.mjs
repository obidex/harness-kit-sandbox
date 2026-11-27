#!/usr/bin/env node
// trial — a kit release tried on every project before it ships (K079). No dependencies, no network, read-only:
// each project is copied into a temporary clone, updated there to the candidate kit exactly as its kit update
// pull request would be, and checked there; the project's own checkout is never written.
//
//   node .harness/tools/trial.mjs --project <dir> [--project <dir> …] [--prepared <name>=<ref> …] [--json <file>]
//
// Run it from the candidate kit's checkout (this file's own repository is the candidate). Each <dir> is a
// clone of a project's current default branch, history included (git clone, then fetch its default branch);
// its HEAD is what the trial updates. Per project:
//   1. before: the project's own pinned audit (`audit.mjs --strict`), to tell old findings from new ones;
//   2. the update: the project's own pinned `harness.mjs update --from <candidate>` (the target's own tool
//      applies it, K006), committed in the temporary clone as the kit update pull request's one commit;
// A project that pins no kit opens no update pull request; only its kit-facing files (a copied workflow's settings
// file, `.github/harness-review.json`) are read with the candidate's tools.
//   3. after: what that pull request's kit checks run: `harness.mjs status`, `hands.mjs validate`, the
//      candidate's precheck against the default branch, and the candidate's `audit.mjs --strict`; and the
//      guard's content check (no one's local state among the changed files).
// A project is GREEN when every check passes, else RED with one plain line per failed check, each marked
// "already failing before this release" when the project's own kit failed it too. `--prepared name=ref` names
// the project's prepared fix (its inbox request or pull request) for a RED project.
//
// The last line is the release's trial line, without project names (the kit is public; the per-project table
// goes on the private card): `Trial: <G> of <N> projects green[; <P> red with the fix prepared][; <R> red] at <commit>`.
// check-version requires it in the version's changelog entry with no plain `red` part (K079). Exit 1 while a
// project is RED with no prepared fix.
//
// GitHub-side checks (rulesets, comment bodies) need `--repo` and a token, which the trial never uses: those are
// read by the project's own weekly audit. A project that pins no kit is left out, and says so.

import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LOCAL_STATE } from './guard.mjs';
import { settingsOf, SETTINGS as REVIEW_SETTINGS } from './review.mjs';

const KIT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ENV = { ...process.env, GIT_AUTHOR_NAME: 'kit trial', GIT_AUTHOR_EMAIL: 'trial@example.invalid', GIT_COMMITTER_NAME: 'kit trial', GIT_COMMITTER_EMAIL: 'trial@example.invalid', GITHUB_ACTIONS: '', GITHUB_STEP_SUMMARY: '' };
const run = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: ENV, maxBuffer: 64 << 20 });
  return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}`.trim() };
};
const git = (cwd, ...a) => run('git', a, cwd);
const lastLine = (t) => String(t || '').split('\n').filter((l) => l.trim()).pop() || '';

/** The rule IDs an `audit.mjs --strict` run failed, from its output: { id: line }. */
export function auditFails(out) {
  const m = {};
  for (const l of String(out || '').split('\n')) { const x = l.match(/^audit: FAIL ([A-Z]+\d+) (.*)$/); if (x) m[x[1]] = x[2]; }
  return m;
}

/** The release's trial line from the per-project verdicts (no project names). */
export function trialLine(results, commit) {
  const judged = results.filter((r) => r.verdict !== 'SKIPPED');
  const green = judged.filter((r) => r.verdict === 'GREEN').length;
  const prepared = judged.filter((r) => r.verdict === 'RED' && r.prepared).length;
  const red = judged.filter((r) => r.verdict === 'RED' && !r.prepared).length;
  return `Trial: ${green} of ${judged.length} projects green${prepared ? `; ${prepared} red with the fix prepared` : ''}${red ? `; ${red} red` : ''} at ${String(commit || '').slice(0, 12)}`;
}

/** Try the candidate kit on one project checkout. Returns { name, verdict, lines, prepared }. */
/** The kit-facing files a project keeps even without a pinned kit (a copied workflow that checks the kit out at a
 *  commit, K054/K060): the candidate must still read them. Lines for what it cannot read. */
export function kitFacing(dir) {
  const lines = [];
  const f = join(dir, REVIEW_SETTINGS);
  if (existsSync(f)) { const { problem } = settingsOf(readFileSync(f, 'utf8')); if (problem) lines.push(`harness-review: the candidate would switch the reviewer off: ${REVIEW_SETTINGS} ${problem}`); }
  return lines;
}

export function tryProject(dir, { kit = KIT, prepared = {} } = {}) {
  const name = basename(resolve(dir));
  if (!existsSync(join(dir, '.harness/kit.lock.json'))) {
    // no pinned kit, so no kit update pull request: only its kit-facing files are tried
    const lines = kitFacing(dir);
    return { name, verdict: lines.length ? 'RED' : existsSync(join(dir, REVIEW_SETTINGS)) ? 'GREEN' : 'SKIPPED', lines: lines.length ? lines : [existsSync(join(dir, REVIEW_SETTINGS)) ? 'pins no kit; its kit-facing settings read under the candidate' : 'pins no kit and keeps no kit-facing file'], prepared: lines.length ? prepared[name] || null : null };
  }
  const tmp = mkdtempSync(join(tmpdir(), `trial-${name}-`));
  const p = join(tmp, name);
  try {
    const head = git(dir, 'rev-parse', 'HEAD').out;
    if (!git(tmp, 'clone', '--quiet', '--no-hardlinks', resolve(dir), p).ok) return { name, verdict: 'RED', lines: ['the trial could not copy the checkout'], prepared: prepared[name] || null };
    let profile = {};
    try { profile = JSON.parse(readFileSync(join(p, '.harness/profile.json'), 'utf8')); } catch { /* the audit says so */ }
    const main = profile?.branches?.default || 'main';
    // the copy's default branch is the checkout's HEAD, as the pull request's base would be
    git(p, 'update-ref', `refs/remotes/origin/${main}`, head);
    git(p, 'symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${main}`);
    git(p, 'checkout', '--quiet', '-B', 'trial', head);
    // an audit that exits non-zero without one FAIL line did not finish (it threw, or read a broken file): that is
    // a failure of its own, never a pass
    const audit = (json) => { const a = run(process.execPath, ['.harness/tools/audit.mjs', '.', '--strict', '--json', join(tmp, json)], p); const fails = auditFails(a.out); return { fails, broke: !a.ok && !Object.keys(fails).length ? (a.out.split('\n').find((l) => /\b\w*Error\b/.test(l)) || lastLine(a.out) || 'exit without output').trim().slice(0, 200) : null }; };
    const before = audit('before.json');
    const target = readFileSync(join(kit, '.harness/VERSION'), 'utf8').trim();
    const was = readFileSync(join(p, '.harness/VERSION'), 'utf8').trim();
    const lines = [];
    const up = run(process.execPath, ['.harness/tools/harness.mjs', 'update', '--root', '.', '--from', kit, '--version', target], p);
    if (!up.ok) lines.push(`the update ${was} → ${target} itself failed: ${lastLine(up.out).slice(0, 200)}`);
    else if (was === target) lines.push(`already at ${target}: nothing to try (raise VERSION in the candidate first)`);
    else {
      git(p, 'add', '-A');
      const cm = git(p, 'commit', '--quiet', '--no-gpg-sign', '--no-verify', '-m', `chore(harness): update kit ${was} to ${target} (trial)`);
      if (!cm.ok) { lines.push(`the trial could not commit the update in its copy, so nothing after it was checked: ${lastLine(cm.out).slice(0, 200)}`); return { name, verdict: 'RED', lines, prepared: prepared[name] || null }; }
      const changed = git(p, 'diff', '--name-only', 'HEAD~1', 'HEAD').out.split('\n').filter(Boolean);
      const local = changed.filter((f) => LOCAL_STATE.test(f));
      if (local.length) lines.push(`harness-guard: the update would add one person's local state (${local.join(', ')})`);
      const st = run(process.execPath, ['.harness/tools/harness.mjs', 'status', '--root', '.'], p);
      if (!st.ok) lines.push(`harness-audit: kit files do not match the lock after the update: ${lastLine(st.out).slice(0, 200)}`);
      const va = run(process.execPath, ['.harness/tools/hands.mjs', 'validate', '.'], p);
      if (!va.ok) lines.push(`harness-audit: the settings file is not valid under ${target}: ${lastLine(va.out).slice(0, 200)}`);
      const pc = run(process.execPath, ['.harness/tools/precheck.mjs', '--base', head], p);
      if (!pc.ok) lines.push(`harness-audit precheck: ${pc.out.split('\n').filter((l) => /FAILED/.test(l)).map((l) => l.replace(/^.*FAILED: /, '')).join(' | ').slice(0, 300)}`);
      const after = audit('after.json');
      lines.push(...kitFacing(p));
      if (after.broke) lines.push(`harness-audit: the audit did not finish: ${after.broke}${before.broke ? ' (already failing before this release)' : ''}`);
      for (const [id, line] of Object.entries(after.fails)) lines.push(`harness-audit ${id}: ${line.slice(0, 260)}${before.fails[id] ? ' (already failing before this release)' : ''}`);
    }
    const verdict = lines.length ? 'RED' : 'GREEN';
    return { name, verdict, lines, prepared: verdict === 'RED' ? prepared[name] || null : null };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const all = (n) => argv.flatMap((a, i) => (a === n && argv[i + 1] ? [argv[i + 1]] : []));
  const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const projects = all('--project');
  if (!projects.length) { console.error('usage: trial.mjs --project <dir> [--project <dir> …] [--prepared <name>=<ref> …] [--json <file>]  (see the header)'); process.exit(2); }
  const prepared = Object.fromEntries(all('--prepared').map((x) => [x.split('=')[0], x.split('=').slice(1).join('=')]).filter(([k, v]) => k && v));
  const commit = git(KIT, 'rev-parse', 'HEAD').out;
  const results = projects.map((d) => tryProject(d, { prepared }));
  for (const r of results) {
    console.log(`${r.name}: ${r.verdict}${r.prepared ? ` (fix prepared: ${r.prepared})` : ''}`);
    for (const l of r.lines) console.log(`  - ${l}`);
  }
  const line = trialLine(results, commit);
  if (opt('--json')) writeFileSync(opt('--json'), JSON.stringify({ commit, version: readFileSync(join(KIT, '.harness/VERSION'), 'utf8').trim(), results, line }, null, 2));
  console.log(line);
  if (results.some((r) => r.verdict === 'RED' && !r.prepared)) process.exit(1);
}
