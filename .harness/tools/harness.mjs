#!/usr/bin/env node
// harness — install, update and roll back the kit's pinned copy in a project (card H2). No dependencies.
//
//   node .harness/tools/harness.mjs init     --version X.Y.Z [--from <kit checkout>] [--preset web-app|public-website|none]
//   node .harness/tools/harness.mjs update   --version X.Y.Z [--from <kit checkout>]
//   node .harness/tools/harness.mjs rollback                  (to the version the lock records as previous)
//   node .harness/tools/harness.mjs status                    (exit 1 if a kit-managed file drifted)
//   node .harness/tools/harness.mjs latest                    (print the newest released kit version)
//   node .harness/tools/harness.mjs paths                     (every path the lock, or the lock committed at HEAD, lists: what an update PR stages)
//
// Run from the project root (or pass --root <dir>). The kit comes from --from, or from the tag
// v<version> of $HARNESS_KIT_REPO (default https://github.com/obidex/harness-kit).
//
// What the kit owns in a project, and nothing else:
//   .harness/**                      every kit file except profile.json and kit.lock.json
//   .github/workflows/harness-*.yml  from the kit's .harness/templates/workflows/
//   .claude/skills/<name>/**         from the kit's .harness/templates/skills/<name>/ (only those names)
// Recorded with their hashes in .harness/kit.lock.json. Everything else is project-owned and never
// written by update or rollback. init writes three project-owned files only when they are absent or
// lack the kit: .harness/profile.json (a skeleton), CLAUDE.md (created, or the kit imports added).
//
// Versions are immutable: a version is a tag the kit never moves. The lock records the commit each
// tag pointed to; update refuses to proceed if the installed version's tag now points elsewhere, and
// refuses if a kit-managed file was edited in the project (changes come through the kit).
//
// The target version's own tool writes the files (K006): update and rollback check the lock and the
// tag here, then hand the fetched kit to its harness.mjs, so a release that changes what the kit
// manages takes effect on the update that installs it. A version older than 0.4.0 has no such entry
// point, and this tool applies it instead.

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, mkdtempSync, rmdirSync, readdirSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { walk, sha256 } from './lib.mjs';

const [cmd, ...argv] = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const root = resolve(opt('--root') || '.');
const KIT_REPO = process.env.HARNESS_KIT_REPO || 'https://github.com/obidex/harness-kit';
const LOCK = '.harness/kit.lock.json';
// project-owned files that live under .harness/: the kit never ships, writes or deletes them
const OWNED_IN_HARNESS = new Set(['.harness/profile.json', LOCK, '.harness/audit-baseline.json']);

const die = (msg) => { console.error(`harness: ${msg}`); process.exit(1); };
const say = (msg) => console.log(`harness: ${msg}`);
const run = (c, a, o = {}) => execFileSync(c, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...o }).trim();
const at = (p) => join(root, p);
const readLock = () => (existsSync(at(LOCK)) ? JSON.parse(readFileSync(at(LOCK), 'utf8')) : null);
const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+$/;
// the entry point one version's tool calls on another's; `__apply --protocol` prints it (the handshake)
const APPLY_PROTOCOL = 'harness-apply/1';
const cmpVer = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };

/** The commit a version tag points to in the kit repo (peeled); null if absent, undefined if unreadable. */
function tagCommit(version, repo = KIT_REPO) {
  let out;
  try { out = run('git', ['ls-remote', '--tags', repo, `refs/tags/v${version}`, `refs/tags/v${version}^{}`]); } catch { return undefined; }
  const lines = out.split('\n').filter(Boolean).map((l) => l.split('\t'));
  const peeled = lines.find(([, r]) => r.endsWith('^{}'));
  return (peeled || lines[0] || [])[0] || null;
}

/** Fetch the kit at a version. Returns { dir, version, commit, source, cleanup }. */
function fetchKit(version) {
  const from = opt('--from');
  if (from) {
    const dir = resolve(from);
    const v = readFileSync(join(dir, '.harness/VERSION'), 'utf8').trim();
    if (version && v !== version) die(`--from holds kit ${v}, not ${version}`);
    let commit = 'local';
    try { commit = run('git', ['-C', dir, 'rev-parse', 'HEAD']); } catch { /* not a git checkout */ }
    return { dir, version: v, commit, source: 'local', cleanup() {} };
  }
  if (!version || !VERSION_RE.test(version)) die('--version X.Y.Z is required');
  const tmp = mkdtempSync(join(tmpdir(), 'harness-kit-'));
  try { run('git', ['clone', '--quiet', '--depth', '1', '--branch', `v${version}`, KIT_REPO, tmp]); }
  catch (e) { rmSync(tmp, { recursive: true, force: true }); die(`kit v${version} not found at ${KIT_REPO}: ${String(e.stderr || e.message).trim()}`); }
  const v = readFileSync(join(tmp, '.harness/VERSION'), 'utf8').trim();
  if (v !== version) { rmSync(tmp, { recursive: true, force: true }); die(`tag v${version} holds VERSION ${v}: refusing a mislabelled release`); }
  return { dir: tmp, version: v, commit: run('git', ['-C', tmp, 'rev-parse', 'HEAD']), source: KIT_REPO, cleanup() { rmSync(tmp, { recursive: true, force: true }); } };
}

/** The managed files a kit provides: destination path → source path. */
function managedFrom(kitDir) {
  const out = {};
  for (const rel of walk(join(kitDir, '.harness'))) {
    const dest = `.harness/${rel}`;
    if (OWNED_IN_HARNESS.has(dest) || rel.startsWith('templates/')) continue;
    out[dest] = join(kitDir, '.harness', rel);
  }
  for (const rel of walk(join(kitDir, '.harness/templates/workflows'))) {
    if (/^harness-[a-z0-9-]+\.ya?ml$/.test(rel)) out[`.github/workflows/${rel}`] = join(kitDir, '.harness/templates/workflows', rel);
  }
  for (const rel of walk(join(kitDir, '.harness/templates/skills'))) out[`.claude/skills/${rel}`] = join(kitDir, '.harness/templates/skills', rel);
  return out;
}

/** Managed files whose content differs from the lock (edited, missing). */
function drift(lock) {
  return Object.entries(lock.files).filter(([p, h]) => !existsSync(at(p)) || sha256(readFileSync(at(p))) !== h).map(([p]) => p);
}

function removeEmptyDirs(dir) {
  if (!existsSync(dir) || dir === root) return;
  if (readdirSync(dir).length === 0) { rmdirSync(dir); removeEmptyDirs(dirname(dir)); }
}

/** Write the kit's managed files; remove ones the previous lock had that the new kit dropped. */
function apply(kit, oldLock) {
  const files = managedFrom(kit.dir);
  // A path the kit now claims that the project already holds, and the previous lock did not list,
  // is the project's file: refuse rather than overwrite it (init adopts an identical copy).
  const clash = Object.entries(files).filter(([dest, src]) => existsSync(at(dest)) && !(dest in (oldLock?.files || {}))
    && sha256(readFileSync(at(dest))) !== sha256(readFileSync(src))).map(([dest]) => dest);
  if (clash.length) { kit.cleanup(); die(`these project files sit where kit ${kit.version} installs its own; move or rename them first, nothing was changed:\n  ${clash.join('\n  ')}`); }
  const hashes = {};
  let added = 0, changed = 0, removed = 0;
  for (const [dest, src] of Object.entries(files)) {
    const buf = readFileSync(src);
    hashes[dest] = sha256(buf);
    if (!existsSync(at(dest))) added++;
    else if (oldLock?.files?.[dest] !== hashes[dest]) changed++;
    else continue;
    mkdirSync(dirname(at(dest)), { recursive: true });
    writeFileSync(at(dest), buf);
  }
  for (const dest of Object.keys(oldLock?.files || {})) {
    if (dest in files) continue;
    rmSync(at(dest), { force: true }); removed++;
    removeEmptyDirs(dirname(at(dest)));
  }
  const lock = {
    version: kit.version,
    commit: kit.commit,
    source: kit.source,
    previous: oldLock ? { version: oldLock.version, commit: oldLock.commit } : null,
    files: Object.fromEntries(Object.entries(hashes).sort(([a], [b]) => a.localeCompare(b))),
  };
  writeFileSync(at(LOCK), `${JSON.stringify(lock, null, 2)}\n`);
  return { added, changed, removed, total: Object.keys(files).length };
}

function guardUpdate(lock, target) {
  if (!lock) die('the kit is not installed here: run init');
  const d = drift(lock);
  if (d.length) die(`kit-managed files were edited in this project, so the update would lose those edits:\n  ${d.join('\n  ')}\nMove the change into the kit (or the project's own files) and restore these first.`);
  if (lock.source !== 'local' && !opt('--from')) {
    const now = tagCommit(lock.version, lock.source);
    if (now === undefined) die(`cannot read the tags of ${lock.source}; the installed version's tag must be checked before an update`);
    if (now === null) die(`tag v${lock.version} no longer exists at ${lock.source}: kit versions are immutable, so stop and report`);
    if (now !== lock.commit) die(`tag v${lock.version} now points to ${now.slice(0, 12)}, but ${lock.commit.slice(0, 12)} was installed: kit versions are immutable, so stop and report`);
  }
  if (target === lock.version) { say(`already at ${target}; nothing to do`); process.exit(0); }
}

// --- init-only: project-owned files, written only when absent -------------------------------------------
function initProjectFiles(kit) {
  const written = [];
  if (!existsSync(at('.harness/profile.json'))) {
    const example = JSON.parse(readFileSync(join(kit.dir, 'examples/profile.example.json'), 'utf8'));
    const preset = opt('--preset') || 'none';
    let capabilities = [];
    if (preset !== 'none') {
      const line = readFileSync(join(kit.dir, `.harness/presets/${preset}.md`), 'utf8').match(/^\*\*Capabilities:\*\* (.+)$/m);
      capabilities = line ? line[1].split(' · ').map((c) => c.trim().replace(/[ /]/g, '-')) : [];
    }
    let repo = 'owner/name';
    try { repo = run('git', ['-C', root, 'remote', 'get-url', 'origin']).replace(/^.*github\.com[:/]/, '').replace(/\.git$/, ''); } catch { /* no remote */ }
    const profile = {
      ...example,
      project: { name: basename(root), repo, summary: 'TODO: one line.' },
      preset, capabilities,
      exceptions: [],
    };
    delete profile.kit; // the version's one home is .harness/VERSION (K003)
    writeFileSync(at('.harness/profile.json'), `${JSON.stringify(profile, null, 2)}\n`);
    written.push('.harness/profile.json (skeleton from the kit example: replace every value before relying on the audit)');
  }
  const imports = ['@.harness/core.md', '@.harness/owner-defaults.md'];
  if (!existsSync(at('CLAUDE.md'))) {
    let t = readFileSync(join(kit.dir, 'examples/CLAUDE.md'), 'utf8').replace('<project name>', basename(root));
    if (!existsSync(at('AGENTS.md'))) t = t.replace(/^@AGENTS\.md\n/m, '');
    writeFileSync(at('CLAUDE.md'), t);
    written.push('CLAUDE.md (created from the kit example)');
  } else {
    const t = readFileSync(at('CLAUDE.md'), 'utf8');
    const missing = [...imports, '@.harness/VERSION'].filter((i) => !t.split('\n').includes(i));
    if (missing.length) {
      const block = `${missing.join('\n')}\n`;
      // after the first heading if there is one, else at the top
      const m = t.match(/^# .*\n(\n)?/);
      const out = m ? t.slice(0, m[0].length) + block + (m[1] ? '\n' : '') + t.slice(m[0].length) : block + '\n' + t;
      writeFileSync(at('CLAUDE.md'), out);
      written.push(`CLAUDE.md (added ${missing.join(', ')})`);
    }
  }
  return written;
}

// --- commands --------------------------------------------------------------------------------------------
switch (cmd) {
  case 'init': {
    if (readLock()) die('the kit is already installed here: use update');
    const kit = fetchKit(opt('--version'));
    const r = apply(kit, null);
    const w = initProjectFiles(kit);
    kit.cleanup();
    say(`installed kit ${kit.version} (${kit.commit.slice(0, 12)}): ${r.total} managed files`);
    for (const x of w) say(`wrote ${x}`);
    break;
  }
  case 'update':
  case 'rollback': {
    const lock = readLock();
    const target = cmd === 'rollback' ? lock?.previous?.version || die('the lock records no previous version to roll back to') : opt('--version');
    if (cmd === 'update' && !opt('--from') && !target) die('--version X.Y.Z is required');
    guardUpdate(lock, target);
    const kit = fetchKit(target);
    if (cmd === 'rollback' && lock.previous.commit !== 'local' && kit.commit !== lock.previous.commit && !opt('--from')) {
      kit.cleanup(); die(`tag v${target} now points to ${kit.commit.slice(0, 12)}, not ${lock.previous.commit.slice(0, 12)} as installed before`);
    }
    const verb = cmd === 'rollback' ? 'rolled back' : 'updated';
    const targetTool = join(kit.dir, '.harness/tools/harness.mjs');
    const speaks = existsSync(targetTool) && resolve(targetTool) !== fileURLToPath(import.meta.url)
      && spawnSync(process.execPath, [targetTool, '__apply', '--protocol'], { encoding: 'utf8' }).stdout?.trim() === APPLY_PROTOCOL;
    if (speaks) {
      const r = spawnSync(process.execPath, [targetTool, '__apply', '--root', root, '--kit-dir', kit.dir, '--kit-version', kit.version, '--kit-commit', kit.commit, '--kit-source', kit.source], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
      kit.cleanup();
      if (r.status !== 0) die(`kit ${kit.version}'s own tool could not apply it (exit ${r.status ?? r.signal})`);
      say(`${verb} kit ${lock.version} → ${kit.version} (${kit.commit.slice(0, 12)}): ${r.stdout.trim()}; applied by kit ${kit.version}'s own tool; project-owned files untouched`);
      break;
    }
    const r = apply(kit, lock);
    kit.cleanup();
    say(`${verb} kit ${lock.version} → ${kit.version} (${kit.commit.slice(0, 12)}): ${r.added} added, ${r.changed} changed, ${r.removed} removed; project-owned files untouched`);
    break;
  }
  case '__apply': {
    // called by another version's update or rollback after it checked the lock and the tag (harness-apply/1)
    if (argv.includes('--protocol')) { console.log(APPLY_PROTOCOL); break; }
    const lock = readLock();
    if (!lock) die('the kit is not installed here');
    const dir = opt('--kit-dir'), version = opt('--kit-version'), commit = opt('--kit-commit'), source = opt('--kit-source');
    if (!dir || !version || !commit || !source) die('__apply needs --kit-dir, --kit-version, --kit-commit and --kit-source');
    if (readFileSync(join(dir, '.harness/VERSION'), 'utf8').trim() !== version) die(`${dir} does not hold kit ${version}`);
    const r = apply({ dir, version, commit, source, cleanup() {} }, lock);
    console.log(`${r.added} added, ${r.changed} changed, ${r.removed} removed`);
    break;
  }
  case 'status': {
    const lock = readLock();
    if (!lock) die('the kit is not installed here');
    const d = drift(lock);
    if (d.length) { console.log(`harness: kit ${lock.version}: ${d.length} managed file(s) drifted:\n  ${d.join('\n  ')}`); process.exit(1); }
    say(`kit ${lock.version} (${lock.commit.slice(0, 12)}): ${Object.keys(lock.files).length} managed files match the lock`);
    break;
  }
  case 'paths': {
    const lock = readLock();
    if (!lock) die('the kit is not installed here');
    let before = {};
    try { before = JSON.parse(run('git', ['-C', root, 'show', `HEAD:${LOCK}`])).files || {}; } catch { /* no committed lock yet */ }
    console.log([...new Set([...Object.keys(before), ...Object.keys(lock.files), LOCK])].sort().join('\n'));
    break;
  }
  case 'latest': {
    const out = run('git', ['ls-remote', '--tags', '--refs', KIT_REPO, 'refs/tags/v*']);
    const versions = out.split('\n').map((l) => l.split('refs/tags/v')[1]).filter((v) => v && VERSION_RE.test(v)).sort(cmpVer);
    if (!versions.length) die(`no released version at ${KIT_REPO}`);
    console.log(versions.at(-1));
    break;
  }
  default:
    die('usage: harness.mjs init|update|rollback|status|latest|paths  (see the header of this file)');
}
