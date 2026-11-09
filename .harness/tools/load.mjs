#!/usr/bin/env node
// load — what a Claude session loads before its first word, and its token budget (C17, K034).
//
//   node .harness/tools/load.mjs [<root>] [--budget <tokens>] [--json]
//                                   lists every always-loaded file with its size and the estimated
//                                   total; exit 1 when the total is over the budget
//
// Always loaded (adapter A15): CLAUDE.md (or .claude/CLAUDE.md) and every file it imports with
// `@path`, recursively (at most 5 hops, as Claude Code does), plus every `.claude/rules/**/*.md`
// without a `paths:` frontmatter. A rule file with `paths:` loads only when matching files are read:
// it is listed as conditional and kept out of the total. An `@` inside a code span or fence is not an
// import, nor is one whose path does not resolve to a file in the checkout (a mention such as @owner).
//
// Tokens are an ESTIMATE, with no tokenizer and no network: UTF-8 bytes divided by 3.5, rounded up.
// English Markdown runs about 4 characters a token, so the estimate errs high, which is the safe side
// for a budget. The budget is profile.canon.load_budget_tokens, else DEFAULT_BUDGET.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_BUDGET = 8000;   // estimated tokens for the whole always-loaded set
export const BYTES_PER_TOKEN = 3.5;
export const MAX_HOPS = 5;
export const tokens = (bytes) => Math.ceil(bytes / BYTES_PER_TOKEN);

/** The `@path` imports of a Markdown text, outside code fences and inline code spans. */
export function importsOf(text) {
  const out = [];
  let fence = null;
  for (const line of String(text).split('\n')) {
    const f = line.match(/^\s*(`{3,}|~{3,})/);
    if (f) { if (!fence) fence = f[1][0]; else if (f[1][0] === fence) fence = null; continue; }
    if (fence) continue;
    const plain = line.replace(/`+[^`]*`+/g, ' ');
    for (const m of plain.matchAll(/(?:^|[\s(])@((?:~|\.{1,2})?\/?[\w.\-/]+[\w])/g)) out.push(m[1]);
  }
  return out;
}

/** True when a .claude/rules file loads only for matching paths (frontmatter `paths:`). */
export function conditional(text) {
  const fm = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  return Boolean(fm && /^paths\s*:/m.test(fm[1]));
}

function rulesFiles(root) {
  const base = join(root, '.claude/rules');
  if (!existsSync(base)) return [];
  const out = [];
  const walk = (d) => { for (const e of readdirSync(d).sort()) { const p = join(d, e); if (statSync(p).isDirectory()) walk(p); else if (e.endsWith('.md')) out.push(p); } };
  walk(base);
  return out;
}

/** The always-loaded set of a checkout: { files: [{ path, bytes, via }], conditional: [...], bytes, tokens }. */
export function loadSet(root) {
  root = resolve(root);
  const inside = (p) => p === root || p.startsWith(root + sep);
  const files = [];
  const seen = new Set();
  const add = (abs, via, hop) => {
    if (seen.has(abs) || !inside(abs) || !existsSync(abs) || !statSync(abs).isFile()) return;
    seen.add(abs);
    const buf = readFileSync(abs);
    files.push({ path: relative(root, abs), bytes: buf.length, via });
    if (hop >= MAX_HOPS) return;
    for (const imp of importsOf(buf.toString('utf8'))) {
      if (imp.startsWith('~')) continue;          // a user's home file, not in the checkout
      add(resolve(dirname(abs), imp), relative(root, abs), hop + 1);
    }
  };
  for (const top of ['CLAUDE.md', '.claude/CLAUDE.md']) add(join(root, top), 'session', 0);
  const cond = [];
  for (const p of rulesFiles(root)) {
    const text = readFileSync(p, 'utf8');
    if (conditional(text)) cond.push({ path: relative(root, p), bytes: Buffer.byteLength(text) });
    else add(p, '.claude/rules', 0);
  }
  const bytes = files.reduce((s, f) => s + f.bytes, 0);
  return { files, conditional: cond, bytes, tokens: tokens(bytes) };
}

/** The budget for a checkout: its profile's canon.load_budget_tokens, else the default. */
export function budgetOf(root) {
  try {
    const p = JSON.parse(readFileSync(join(root, '.harness/profile.json'), 'utf8'));
    const b = p?.canon?.load_budget_tokens;
    if (Number.isInteger(b) && b > 0) return b;
  } catch { /* no profile: the default */ }
  return DEFAULT_BUDGET;
}

export function render(set, budget) {
  const lines = set.files.map((f) => `${String(f.bytes).padStart(7)} B  ~${String(tokens(f.bytes)).padStart(5)} tok  ${f.path}${f.via === 'session' ? '' : `  (from ${f.via})`}`);
  for (const c of set.conditional) lines.push(`${String(c.bytes).padStart(7)} B  ~${String(tokens(c.bytes)).padStart(5)} tok  ${c.path}  (conditional: paths:, not counted)`);
  lines.push(`total ${set.bytes} B, about ${set.tokens} tokens of a budget of ${budget} (${Math.round((100 * set.tokens) / budget)}%)`);
  return lines.join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--budget');
  const root = args.find((a, k) => !a.startsWith('--') && args[k - 1] !== '--budget') || '.';
  const budget = i >= 0 ? Number(args[i + 1]) : budgetOf(root);
  if (!Number.isInteger(budget) || budget <= 0) { console.error('load: --budget takes a whole number of tokens'); process.exit(2); }
  const set = loadSet(root);
  if (args.includes('--json')) console.log(JSON.stringify({ ...set, budget }, null, 2));
  else console.log(render(set, budget));
  if (!set.files.length) { console.error('load: no CLAUDE.md in this checkout'); process.exit(1); }
  if (set.tokens > budget) { console.error(`load: FAIL about ${set.tokens} tokens are always loaded, over the budget of ${budget}`); process.exit(1); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
