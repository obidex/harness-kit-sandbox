#!/usr/bin/env node
// owner-step — the two checks behind O17 and O02 (K058): a step reaches the owner only after it was
// designed away at the plan and tried on every rung. No dependencies, no network.
//
//   node .harness/tools/owner-step.mjs plan <card.md | ->   a card (issue body) with an owner step
//        lists the designs that need no one and why each fails ("No-one designs"); a step that
//        involves a secret lists the three no-carry designs (O04)
//   node .harness/tools/owner-step.mjs ask <message.md | ->  a message that waits on the owner
//        (`WAITING FOR YOU`) carries one line beginning `Tried:` naming each rung and what stopped it
//
// Exit 0 = the text passes (or has no owner step), 1 = it fails, with one line per problem; 2 = usage.
// What it reads is text: it decides only whether the required lists are there and complete. Whether
// each design truly fails is the reviewer's judgment (`owner-steps.md`).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Lines that put a step on the owner: a WAITING FOR YOU, an "owner step", or a step "he" or "the owner" does. */
export const OWNER_STEP = /\bWAITING FOR YOU\b|\bowner[- ]steps?\b|\bowner'?s? (?:part|paste|tap|action)\b|\b(?:the owner|he) (?:makes?|pastes?|runs?|creates?|types?|clicks?|signs? in|copies|generates?)\b|\b(?:made|pasted|run|created|typed|done) by (?:him|the owner)\b/i;
/** A step that involves a secret. */
export const SECRET = /\b(?:secret|token|password|private key|api key|key file|credential)s?\b/i;
/** The three designs O04 tries before anyone carries a secret, each by what it must mention. */
export const SECRET_DESIGNS = [
  ['made on the machine where it lives', /\bwhere it lives\b|\bon the (?:machine|box|server)\b/i],
  ['moved machine to machine as a file nobody opens', /\bfile\b/i],
  ['the machine signs in as an App and gets short-lived tokens', /\bapp\b/i],
];
/** The O17 rungs a `Tried:` line names, in the ladder's order, each by how its part begins. */
export const RUNGS = [
  ['redesign', /^(?:re)?design\b/i],
  ['an API or a script', /^(?:an? )?(?:API|script)\b/i],
  ['his terminal (Remote Control)', /^(?:his )?(?:terminal|Remote Control)\b/i],
  ['his signed-in browser', /^(?:his )?(?:signed-in )?browser\b/i],
];
/** A line that says there is no owner step. */
const NO_STEP = /\bno owner[- ]steps?\b|\bowner[- ]steps?[\s:*_—–-]*(?:none|n\/a)\b/i;

const HEADING = /^(?:#{1,6}\s*|\*\*)?\s*No-one designs\b/i;
const ITEM = /^\s*(?:[-*]|\d+[.)])\s+(.*)$/;
const REASON = /\s(?:—|–|-{1,2})\s+\S|:\s+\S|\bbecause\b|\bfails?\b|\bfits?\b/i;
const strip = (t) => String(t || '').replace(/<!--[\s\S]*?-->/g, '').replace(/\r/g, '');

/** The "No-one designs" list of a card: its items, or null when the card has none. */
export function designs(text) {
  const lines = strip(text).split('\n');
  const at = lines.findIndex((l) => HEADING.test(l.trim()));
  if (at < 0) return null;
  const items = [];
  const inline = lines[at].replace(/^.*?No-one designs\**:?\**/i, '').trim();
  if (inline) items.push(inline);
  for (const l of lines.slice(at + 1)) {
    if (!l.trim()) { if (items.length) break; continue; }
    const m = l.match(ITEM);
    if (!m) break;
    items.push(m[1].trim());
  }
  return items;
}

/** Problems with a card's plan (O17, O04); [] when it passes or has no owner step. */
export function planProblems(text) {
  const body = strip(text);
  const steps = body.split('\n').filter((l) => OWNER_STEP.test(l) && !NO_STEP.test(l) && !HEADING.test(l.trim()));
  if (!steps.length) return [];
  const list = designs(body);
  if (!list) return ['the card has an owner step but no "No-one designs" list (O17): list the designs that need no one and why each fails'];
  if (!list.length) return ['the "No-one designs" list is empty (O17)'];
  const out = [];
  for (const item of list) if (!REASON.test(` ${item}`)) out.push(`design "${item.slice(0, 80)}" gives no reason it fails or fits (write "<design> — fails: <why>")`);
  if (steps.some((l) => SECRET.test(l)) || SECRET.test(list.join('\n'))) {
    const joined = list.join('\n');
    for (const [name, re] of SECRET_DESIGNS) if (!re.test(joined)) out.push(`the owner step involves a secret, and the list misses the no-carry design "${name}" (O04)`);
  }
  return out;
}

/** Problems with a message that waits on the owner (O02, O17); [] when it passes or waits on no one. */
export function askProblems(text) {
  const body = strip(text);
  if (!/\bWAITING FOR YOU\b/.test(body)) return [];
  const tried = body.split('\n').map((l) => l.trim().replace(/^[*_>\s-]+/, '').replace(/^Tried:[*_]+/, 'Tried:')).filter((l) => /^Tried:/.test(l));
  if (!tried.length) return ['the message waits on the owner but has no line beginning "Tried:" (O02): name each rung and what stopped it'];
  if (tried.length > 1) return ['the message has more than one "Tried:" line: one line names every rung'];
  // one part per rung, split on ";" or "·": each part begins with its rung, then ":" or a dash and
  // what stopped it ("browser: the page asks for his code")
  const parts = tried[0].slice('Tried:'.length).split(/[;·]/).map((p) => p.replace(/^[\s*_]+|[\s*_]+$/g, '')).filter(Boolean);
  const out = [];
  if (parts.length < RUNGS.length) out.push(`the "Tried:" line has ${parts.length} part(s): one per rung, ${RUNGS.length} in all, split by ";"`);
  for (const [name, re] of RUNGS) {
    const part = parts.find((p) => re.test(p));
    if (!part) { out.push(`the "Tried:" line has no part beginning with the rung "${name}" (O17)`); continue; }
    const sep = part.match(/^[^:—–]*?(?::|\s[—–-]{1,2}\s)\s*(.*)$/);
    const reason = sep ? sep[1] : '';
    if ((reason.match(/[A-Za-z]{2,}/g) || []).length < 2) out.push(`the "Tried:" line names "${name}" but not what stopped it`);
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, file] = process.argv.slice(2);
  if (!['plan', 'ask'].includes(cmd) || !file) { console.log('usage: owner-step.mjs plan|ask <file | ->'); process.exit(2); }
  const text = readFileSync(file === '-' ? 0 : file, 'utf8');
  const problems = cmd === 'plan' ? planProblems(text) : askProblems(text);
  for (const p of problems) console.log(`owner-step: FAIL ${p}`);
  if (problems.length) process.exit(1);
  console.log(`owner-step: OK · ${cmd === 'plan' ? 'no owner step, or its no-one designs are listed' : 'no wait on the owner, or its Tried: line names every rung'}`);
}
