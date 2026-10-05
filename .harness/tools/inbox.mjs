#!/usr/bin/env node
// inbox — cross-project requests as issues (O14, K009). No dependencies.
//
//   node .harness/tools/inbox.mjs send --repo owner/name --id <stable id> --title <t> --outcome <text>
//        --source <link> --coordinator <who> --covered-by <owner decision or delegation>
//                                         file one request in the repository that does the work; the
//                                         same id twice never makes a second open issue (prints the
//                                         first; a copy filed in a race closes as its duplicate)
//   node .harness/tools/inbox.mjs pending --repo owner/name     the queued requests (JSON)
//   node .harness/tools/inbox.mjs state --repo owner/name --issue <n> --to working|blocked|done
//        [--note <text>]                  move a request; `done` needs --note with the evidence and
//                                         closes the issue, `blocked` needs --note with the reason
//   node .harness/tools/inbox.mjs wake --repo owner/name --issue <n>
//                                         in Actions (harness-inbox.yml): if that issue is a queued
//                                         request, fire the receiving coordinator's routine
//
// A request is an issue labelled `inbox`. Its body carries one hidden marker `<!-- inbox-id: … -->`
// and these lines, which only this tool edits: ID, Source, Outcome, Responsible coordinator,
// Covered by, State, Evidence. Replies and progress are comments on the issue; the sender reads the
// result there. GH_TOKEN (or the session's own GitHub access) reads and writes the issues.

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LABEL = 'inbox';
export const STATES = ['queued', 'working', 'blocked', 'done'];
const FIELDS = ['ID', 'Source', 'Outcome', 'Responsible coordinator', 'Covered by', 'State', 'Evidence'];

/** The issue body for a new request. */
export function body(r) {
  for (const k of ['id', 'source', 'outcome', 'coordinator', 'coveredBy']) if (!r[k] || !String(r[k]).trim()) throw new Error(`--${k === 'coveredBy' ? 'covered-by' : k} is required`);
  if (!/^[\w.-]+(\/[\w.-]+)*$/.test(r.id)) throw new Error(`id "${r.id}" must be letters, digits, . _ - and / only`);
  const one = (s) => String(s).replace(/\s*\n\s*/g, ' ').trim();
  return [`<!-- inbox-id: ${r.id} -->`, 'A cross-project request (Harness Kit inbox, O14). Replies and progress go on this issue.', '',
    `- **ID:** ${r.id}`, `- **Source:** ${one(r.source)}`, `- **Outcome:** ${one(r.outcome)}`, `- **Responsible coordinator:** ${one(r.coordinator)}`,
    `- **Covered by:** ${one(r.coveredBy)}`, '- **State:** queued', '- **Evidence:** none yet', ''].join('\n');
}

/** The fields of a request body; null when the body is not one. */
export function parse(text) {
  const id = String(text || '').match(/<!-- inbox-id: ([^\s]+) -->/);
  if (!id) return null;
  const out = { id: id[1] };
  for (const f of FIELDS) {
    const m = text.match(new RegExp(`^- \\*\\*${f}:\\*\\* ?(.*)$`, 'm'));
    out[f] = m ? m[1].trim() : null;
  }
  return out;
}

/** The body with one field replaced. */
export function setField(text, field, value) {
  const re = new RegExp(`^(- \\*\\*${field}:\\*\\*).*$`, 'm');
  if (!re.test(text)) throw new Error(`the request has no "${field}" line`);
  return text.replace(re, `$1 ${String(value).replace(/\s*\n\s*/g, ' ').trim()}`);
}

// --- GitHub ---------------------------------------------------------------------------------------
async function api(method, path, data) {
  const r = await fetch(`${process.env.GITHUB_API_URL || 'https://api.github.com'}${path}`, {
    method,
    headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'harness-inbox',
      ...(process.env.GH_TOKEN ? { authorization: `Bearer ${process.env.GH_TOKEN}` } : {}), ...(data ? { 'content-type': 'application/json' } : {}) },
    body: data ? JSON.stringify(data) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (r.status < 200 || r.status > 299) throw new Error(`${method} ${path} answered ${r.status}: ${JSON.stringify(json).slice(0, 300)}`);
  return json;
}

/** Every inbox issue of the repository, open and closed, as { number, state, url, fields }. */
export async function requests(repo) {
  const out = [];
  for (let page = 1; page < 50; page++) {
    const l = await api('GET', `/repos/${repo}/issues?labels=${LABEL}&state=all&per_page=100&page=${page}`);
    for (const i of l) { const fields = parse(i.body); if (fields && !i.pull_request) out.push({ number: i.number, state: i.state, url: i.html_url, fields }); }
    if (l.length < 100) break;
  }
  return out;
}

/** The first issue filed for each ID; later ones for the same ID are duplicates and never count. */
export function canonical(list) {
  const first = new Map();
  for (const r of [...list].sort((a, b) => a.number - b.number)) if (!first.has(r.fields.id)) first.set(r.fields.id, r);
  return [...first.values()];
}

const queued = (r) => r.state === 'open' && r.fields.State === 'queued';
const pause = (ms) => new Promise((d) => setTimeout(d, ms));

// --- commands -------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };

async function main() {
  const [cmd] = argv;
  const repo = opt('--repo');
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('--repo owner/name is required');
  if (cmd === 'send') {
    const r = { id: opt('--id'), source: opt('--source'), outcome: opt('--outcome'), coordinator: opt('--coordinator'), coveredBy: opt('--covered-by') };
    const text = body(r); // validates before any read
    const have = canonical(await requests(repo)).find((x) => x.fields.id === r.id);
    if (have) { console.log(`inbox: ${r.id} is already ${have.url} (${have.state}, ${have.fields.State}); nothing filed`); return; }
    const i = await api('POST', `/repos/${repo}/issues`, { title: opt('--title') || r.outcome.slice(0, 80), body: text, labels: [LABEL] });
    // GitHub's label listing lags a new issue by seconds, so two quick sends can both file. Look again
    // after filing: if an earlier issue carries the same ID, this one closes as its duplicate.
    for (let t = 0; t < 3; t++) {
      await pause(Number(process.env.INBOX_RECHECK_MS ?? 3000));
      const first = canonical(await requests(repo)).find((x) => x.fields.id === r.id);
      if (first && first.number < i.number) {
        await api('POST', `/repos/${repo}/issues/${i.number}/comments`, { body: `Duplicate of #${first.number} (same inbox ID ${r.id}).` });
        await api('PATCH', `/repos/${repo}/issues/${i.number}`, { state: 'closed', state_reason: 'duplicate' });
        console.log(`inbox: ${r.id} is already ${first.url}; the copy just filed (#${i.number}) is closed as its duplicate`);
        return;
      }
      if (first) break;
    }
    console.log(`inbox: filed ${r.id} as ${i.html_url}`);
    return;
  }
  if (cmd === 'pending') {
    console.log(JSON.stringify(canonical(await requests(repo)).filter(queued).map((x) => ({ number: x.number, url: x.url, id: x.fields.id, outcome: x.fields.Outcome }))));
    return;
  }
  if (cmd === 'state') {
    const n = Number(opt('--issue')), to = opt('--to'), note = opt('--note');
    if (!STATES.includes(to) || to === 'queued') throw new Error(`--to must be working, blocked or done`);
    if ((to === 'done' || to === 'blocked') && !note) throw new Error(`--to ${to} needs --note (${to === 'done' ? 'the completion evidence' : 'the reason'})`);
    const i = await api('GET', `/repos/${repo}/issues/${n}`);
    const f = parse(i.body);
    if (!f) throw new Error(`#${n} is not an inbox request`);
    let text = setField(i.body, 'State', to);
    if (to === 'done') text = setField(text, 'Evidence', note);
    await api('PATCH', `/repos/${repo}/issues/${n}`, { body: text, ...(to === 'done' ? { state: 'closed', state_reason: 'completed' } : {}) });
    await api('POST', `/repos/${repo}/issues/${n}/comments`, { body: `**${to}**${note ? `: ${note}` : ''}` });
    console.log(`inbox: ${f.id} (#${n}) is ${to}`);
    return;
  }
  if (cmd === 'wake') {
    const n = Number(opt('--issue'));
    const mine = canonical(await requests(repo)).find((x) => x.number === n);
    // only a queued request wakes anyone: a request already picked up or done never re-runs the AI
    if (!mine || !queued(mine)) { console.log(`inbox: #${n} is not a queued request; nobody woken`); return; }
    const url = process.env.INBOX_ROUTINE_URL, token = process.env.INBOX_ROUTINE_TOKEN;
    if (!url || !token) throw new Error('pickup is not wired: set the INBOX_ROUTINE_URL and INBOX_ROUTINE_TOKEN secrets (.harness/inbox.md)');
    const base = (process.env.INBOX_FIRE_BASE || 'https://api.anthropic.com').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!new RegExp(`^${base}/v1/claude_code/routines/trig_[A-Za-z0-9]+/fire$`).test(url)) throw new Error('INBOX_ROUTINE_URL is not a routine fire URL');
    const r = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'anthropic-beta': 'experimental-cc-routine-2026-04-01', 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ text: `Inbox request ${mine.fields.id} is queued: ${mine.url}` }),
    });
    if (!r.ok) throw new Error(`the routine did not start: ${r.status}`);
    console.log(`inbox: woke the receiving coordinator for ${mine.fields.id} (#${n})`);
    return;
  }
  throw new Error('usage: inbox.mjs send|pending|state|wake  (see the header of this file)');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((e) => { console.error(`inbox: ${e.message}`); process.exit(1); });
}
