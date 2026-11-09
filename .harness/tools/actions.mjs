#!/usr/bin/env node
// actions — every automated action names its group (K035; roadmap #48 P10, S-033 item 3). No dependencies.
//
//   node .harness/tools/actions.mjs check [<root>]   exit 0 = every workflow declares an allowed group
//   node .harness/tools/actions.mjs list [<root>]    each workflow and its group
//
// The groups (the owner keeps spending and design, owner rules of 9 Oct 2026):
//   auto       runs and reports by itself: checks, reports, alerts, duplicate detection, wakes, scrubbing
//   approval   changes something only behind a gate a person or a required check holds: merges on
//              green gates, settings applied from merged files, kit-update PRs, customer-facing or
//              master-data changes, a machine step dispatched by hand
//   human      payments, spending, supplier commitments, design picks, destructive accounting: a person
//              does it. Never automated, so a workflow that declares it fails this check.
// Each workflow under .github/workflows carries one comment line `# Action group: auto` (or approval)
// among its comment lines. A workflow without one fails too: an unlabelled automation is unexplained.
// Jobs that are not GitHub workflows (a host's timers) carry their group in the project's automation
// registry; this tool checks only what it can read.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const GROUPS = Object.freeze(['auto', 'approval', 'human']);
export const ALLOWED = Object.freeze(['auto', 'approval']);
const LINE = /^#\s*Action group:\s*(\S+)\s*(?:[(—-].*)?$/gim;

/** The groups a workflow's text declares (normally exactly one). */
export const groupsOf = (text) => [...String(text).matchAll(LINE)].map((m) => m[1].toLowerCase().replace(/[.,;]$/, ''));

/** One workflow's verdict: { group, problem } (problem null when it is fine). */
export function verdict(text) {
  const g = groupsOf(text);
  if (!g.length) return { group: null, problem: 'no "# Action group:" line (auto or approval)' };
  if (g.length > 1) return { group: g.join(','), problem: `more than one "# Action group:" line (${g.join(', ')})` };
  if (!GROUPS.includes(g[0])) return { group: g[0], problem: `unknown group "${g[0]}" (auto, approval or human)` };
  if (g[0] === 'human') return { group: 'human', problem: 'group "human" is never run by automation: a person does it, so this workflow must not exist' };
  return { group: g[0], problem: null };
}

/** Every workflow of a project root with its verdict. */
export function check(root = '.') {
  const dir = join(root, '.github/workflows');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort().map((f) => ({ file: `.github/workflows/${f}`, ...verdict(readFileSync(join(dir, f), 'utf8')) }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [cmd, root = '.'] = process.argv.slice(2);
  const list = check(root);
  if (cmd === 'list') { for (const w of list) console.log(`${w.group || '-'}\t${w.file}${w.problem ? `\t(${w.problem})` : ''}`); process.exit(0); }
  if (cmd !== 'check') { console.error('usage: actions.mjs check|list [<root>]'); process.exit(2); }
  const bad = list.filter((w) => w.problem);
  for (const w of bad) console.log(`actions: FAIL ${w.file}: ${w.problem}`);
  console.log(bad.length ? `actions: ${bad.length} of ${list.length} workflow(s) fail` : `actions: OK · ${list.length} workflow(s), each auto or approval`);
  process.exit(bad.length ? 1 : 0);
}
