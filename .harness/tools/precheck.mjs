#!/usr/bin/env node
// precheck — the seconds-long check at the point of the edit, for the audit rules that failed twice (K079).
// No dependencies, no network: it reads the checkout and git only.
//
//   node .harness/tools/precheck.mjs [--root <dir>] [--base <ref>] [--text <file>]...   exit 1 on a problem
//   node .harness/tools/precheck.mjs --install [--root <dir>]     a clone's own pre-commit and commit-msg hooks
//   node .harness/tools/precheck.mjs --message <file>             (the commit-msg hook) the message carries no Claude attribution
//
// What it holds, for THIS change only (the working tree, the index and the commits since the default branch;
// --base names another starting point, as the pull request's base in CI):
// - C17, a written decision is never edited: a file in the decisions folder that the change modifies, deletes
//   or renames fails, naming the command that writes the new decision instead (`decisions.mjs new --supersedes`);
// - C17, the closed log only gains lines: lines it loses must be a word-for-word move into decision files the
//   change adds (decisions.md), else it fails;
// - C17, the register's own rules (`decisions.mjs check`), the profile's byte caps and the always-loaded budget,
//   each only when this change touched its files (an old finding never lands on an unrelated change);
// - O09 and A10, no Claude attribution: each --text file (a pull request body or comment before it is posted)
//   and, through the commit-msg hook, each commit message.
// The full audit (`audit.mjs`) still runs in CI; this catches the same mistakes where they are made, in about a
// second, so they never wait for the next pull request that touches the kit (often a kit update) to surface.
// The two rules are the ones the audit failed on twice or more in the projects' pull requests (roadmap #218);
// a rule that fails twice more joins this list.
//
// Every problem is one plain line (what failed and the next step), on GitHub Actions also an error annotation.

import { readFileSync, existsSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { load, folderFor, movedWordForWord, diffParts, problems as registerProblems, logPath } from './decisions.mjs';
import { loadSet, budgetOf } from './load.mjs';
import { footerLines } from './scrub.mjs';
import { plainFail } from './lib.mjs';

export const RULES = ['C17', 'O09'];
const HOOK = (kind) => `#!/bin/sh
# written by .harness/tools/precheck.mjs --install (K079); not committed, one per clone
${kind === 'commit-msg' ? 'exec node .harness/tools/precheck.mjs --message "$1"' : 'exec node .harness/tools/precheck.mjs'}
`;

/** The problems of one change. `git(args)` returns stdout or null; `read(path)` the working-tree text or null. */
export function check({ root, base, git, read, texts = [] }) {
  const out = [];
  // a base git cannot resolve would read as "nothing changed": that is a failure, never an OK
  if (!(git(['rev-parse', '--verify', '--quiet', `${base}^{${/^4b825dc6/.test(base) ? 'tree' : 'commit'}}`]) || '').trim()) return [['C17', `The starting point ${base} is not a commit in this clone, so this change cannot be checked: fetch it (a shallow clone needs \`git fetch --unshallow\`) or name another with --base`]];
  let profile = null;
  try { profile = JSON.parse(read('.harness/profile.json') || 'null'); } catch { out.push(['C17', 'The profile .harness/profile.json is not JSON, so the caps and the decisions log are unknown; fix the file']); }
  const logFile = logPath(root), folder = folderFor(logFile);
  const status = (git(['diff', '--name-status', '-M', base, '--', folder, logFile]) || '').split('\n').filter(Boolean).map((l) => l.split('\t'));
  const untracked = (git(['ls-files', '--others', '--exclude-standard', '--', folder]) || '').split('\n').filter(Boolean);
  // decision files that existed at the base and were changed, deleted or renamed by this change
  const edited = status.filter(([s, f]) => /^[MDR]/.test(s) && f && f.startsWith(`${folder}/`)).map(([, f]) => f);
  for (const f of edited) {
    const id = f.split('/').pop().replace(/\.md$/, '');
    out.push(['C17', `Decision ${id} (${f}) was changed after it was written. Undo the edit and write a new decision that points to it: node .harness/tools/decisions.mjs new --supersedes ${id}`]);
  }
  // the closed log: lines it loses must be, word for word, the files this change adds
  if (status.some(([s, f]) => f === logFile && /^[MD]/.test(s))) {
    // the same hunk reading as the audit's verified move (a removed `- bullet` line counts)
    const { removed } = diffParts(git(['diff', base, '--', logFile]) || '', logFile, folder);
    if (removed.length) {
      const added = {};
      for (const f of [...status.filter(([s]) => /^A/.test(s)).map(([, f]) => f), ...untracked]) if (f.startsWith(`${folder}/`)) added[f] = String(read(f) || '').split('\n');
      if (!movedWordForWord(removed, added)) out.push(['C17', `The closed decisions log ${logFile} lost lines that are not a word-for-word move into a new decision file. Put the lines back; a change is a new decision: node .harness/tools/decisions.mjs new --supersedes <ID>`]);
    }
  }
  // the rest only where this change touched it, so an old finding never lands on an unrelated change
  const changed = new Set([...(git(['diff', '--name-only', base]) || '').split('\n').filter(Boolean), ...(git(['ls-files', '--others', '--exclude-standard']) || '').split('\n').filter(Boolean)]);
  if ([...changed].some((f) => f === logFile || f.startsWith(`${folder}/`))) for (const p of registerProblems(load(root))) out.push(['C17', `Decisions: ${p}`]);
  for (const [f, max] of Object.entries(profile?.canon?.caps || {})) {
    const t = read(f);
    if (changed.has(f) && t !== null && Buffer.byteLength(t) > max) out.push(['C17', `${f} is ${Buffer.byteLength(t)} bytes, over its cap of ${max}: shorten it (only the owner raises a cap)`]);
  }
  const set = loadSet(root), budget = profile?.canon?.load_budget_tokens || budgetOf(root);
  if (set.files.some((f) => changed.has(f.path)) && set.tokens > budget) out.push(['C17', `The always-loaded set is about ${set.tokens} tokens, over its budget of ${budget}: shorten CLAUDE.md or what it imports (node .harness/tools/load.mjs lists it)`]);
  for (const { name, text } of texts) {
    const found = footerLines(text);
    if (found.length) out.push(['O09', `${name} carries Claude attribution (${found[0].slice(0, 80)}): take the line out before it is posted`]);
  }
  return out;
}

/** The starting point of this change: --base, else where it left the default branch, else HEAD. */
function startOf(git, given) {
  if (given) return given;
  const def = (git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']) || '').trim() || 'origin/main';
  for (const r of [def, 'origin/main', 'origin/master']) {
    const mb = (git(['merge-base', 'HEAD', r]) || '').trim();
    if (mb) return mb;
  }
  // a clone's first commit (no HEAD yet) is judged against the empty tree, so the hook never refuses it for that
  return (git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']) || '').trim() ? 'HEAD' : '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const all = (n) => argv.flatMap((a, i) => (a === n && argv[i + 1] ? [argv[i + 1]] : []));
  const root = resolve(opt('--root') || '.');
  const t0 = Date.now();
  const git = (args) => { try { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; } };
  const read = (p) => { const f = join(root, p); try { return existsSync(f) ? readFileSync(f, 'utf8') : null; } catch { return null; } };
  if (argv.includes('--install')) {
    const dir = (git(['rev-parse', '--git-path', 'hooks']) || '').trim();
    if (!dir) { console.error('precheck: not a git clone'); process.exit(1); }
    const abs = resolve(root, dir);
    mkdirSync(abs, { recursive: true });
    for (const kind of ['pre-commit', 'commit-msg']) {
      const f = join(abs, kind);
      if (existsSync(f) && !readFileSync(f, 'utf8').includes('precheck.mjs')) { console.error(`precheck: ${f} is another hook; left as it is (call node .harness/tools/precheck.mjs from it)`); continue; }
      writeFileSync(f, HOOK(kind)); chmodSync(f, 0o755);
    }
    console.log(`precheck: hooks installed in ${dir} (this clone only); each commit is checked in about a second`);
    process.exit(0);
  }
  if (opt('--message')) {
    const found = footerLines(readFileSync(opt('--message'), 'utf8'));
    if (found.length) { plainFail('precheck O09', `The commit message carries Claude attribution (${found[0].slice(0, 80)}): take the line out`); process.exit(1); }
    process.exit(0);
  }
  const texts = all('--text').map((f) => ({ name: f, text: readFileSync(f, 'utf8') }));
  const found = check({ root, base: startOf(git, opt('--base')), git, read, texts });
  for (const [rule, line] of found) plainFail(`precheck ${rule}`, line);
  if (found.length) process.exit(1);
  console.log(`precheck: OK · ${RULES.join(', ')} for this change in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

