#!/usr/bin/env node
// ask — a question for the owner on a card, answered with a button in the control panel (K026).
// No dependencies.
//
//   node .harness/tools/ask.mjs ask --repo owner/name --issue <n> --id <stable id> --question <text>
//        --option <text> --option <text> [--option …] [--recommended <0-3>]
//                                   put the question on the card (an issue or a pull request) as one
//                                   marked comment and label the card `needs-owner`; the panel host
//                                   shows it in "Needs you" with one button per option
//   node .harness/tools/ask.mjs open --owner <account>
//                                   the panel host: every open question on a labelled card (JSON)
//   node .harness/tools/ask.mjs answer --repo owner/name --issue <n> --id <id> --option <0-3>
//        --by <channel>:<account> --at <ISO time>
//                                   in Actions only (the control repository's hands-answer job, with
//                                   the hands App): write the owner's answer on the card
//
// The way back. The panel host records the press and starts hands-answer with what was pressed. The
// job posts the answer on the card as the App, never as the owner's account: a session subscribed to
// a pull request receives a comment the App posted, never one its own account posted (K024). So:
// - a question asked on a pull request the waiting session watches wakes that session directly;
// - a question asked on an issue wakes the repository's coordinator through its wake channel (the
//   `inbox-wake` pull request, K018), which routes it.
// The first answer counts; a later press is refused on the card as already answered. The host then
// checks each answer the App posted against its own record of presses and takes the label off; an
// answer it has no press for is reported to the owner, never trusted. A press never lifts a safety
// refusal, approves a gate or stands for the owner's approval of anything but the question asked.
// GH_TOKEN (or the session's own GitHub access) reads and writes the card. `open` and `answer` need
// ASK_APP_LOGIN, the hands App's login: no other author's comment is ever an answer.

import { fileURLToPath } from 'node:url';
import { findChannel } from './inbox.mjs';

export const LABEL = 'needs-owner';
export const ASK = 'panel-ask', ANSWER = 'panel-answer';
const TRUSTED = ['OWNER', 'MEMBER', 'COLLABORATOR'];       // who may ask: never a stranger on a public card
const one = (s) => String(s ?? '').replace(/\s*\n\s*/g, ' ').trim();
const shown = (s) => String(s).replace(/</g, '&lt;');                // visible text never opens an HTML comment
const letter = (n) => String.fromCharCode(65 + n);
// JSON inside an HTML comment: no "<" or ">" survives, so the comment can never be closed early
const mark = (kind, data) => `<!-- ${kind} ${JSON.stringify(data).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')} -->`;
// the marker is the comment's first line, never a line inside text it quotes (CI output, a pasted body)
const read = (kind, body) => { const m = String(body || '').match(new RegExp(`^<!-- ${kind} (\\{[^\\n]*\\}) -->(\\n|$)`)); try { return m ? JSON.parse(m[1]) : null; } catch { return null; } };
/** The hands App's login (`<slug>[bot]`), the only author whose comment is an answer: ASK_APP_LOGIN. */
export const appLogin = (env = process.env) => { const l = String(env.ASK_APP_LOGIN || '').trim(); if (!/^[a-z0-9-]+\[bot\]$/.test(l)) throw new Error('ASK_APP_LOGIN must be the hands App\'s login (<slug>[bot])'); return l; };

/** A question, checked: id, question, 2-4 options, the recommended one. */
export function question({ id, question: q, options, recommended = 0 }) {
  if (!/^[\w.-]+(\/[\w.-]+)*$/.test(String(id || '')) || String(id).length > 80) throw new Error(`id "${id}" must be letters, digits, . _ - and /, at most 80`);
  if (!one(q)) throw new Error('--question is required');
  const opts = (options || []).map(one).filter(Boolean);
  if (opts.length < 2 || opts.length > 4) throw new Error('give 2 to 4 options');
  const r = Number(recommended);
  if (!Number.isInteger(r) || r < 0 || r >= opts.length) throw new Error(`--recommended must be 0 to ${opts.length - 1}`);
  return { id: String(id), question: one(q).slice(0, 600), options: opts.map((o) => o.slice(0, 200)), recommended: r };
}

export const askBody = (q) => [mark(ASK, q), `**Question for the owner** (control panel): ${shown(q.question)}`, '',
  ...q.options.map((o, n) => `- **${letter(n)}.** ${shown(o)}${n === q.recommended ? ' (recommended)' : ''}`), '',
  'The owner answers with a button in the control panel; the answer is posted here by the hands App.'].join('\n');

export const answerBody = (q, a) => [mark(ANSWER, { id: q.id, option: a.option, by: a.by, at: a.at }),
  `**The owner's answer** to "${shown(q.question)}": **${letter(a.option)}.** ${shown(q.options[a.option])}`, '',
  `Pressed in the control panel by ${a.by.replace(':', ' account ')} at ${a.at.slice(0, 16).replace('T', ' ')} UTC. It answers this question only.`].join('\n');

/** The questions and answers among a card's comments: a question only from the card's own people,
 *  an answer only from the hands App (`app`, its login; none given: no answer counts); the first of
 *  each id counts. */
export function parse(comments, app = null) {
  const asks = {}, answers = {};
  for (const c of comments) {
    const q = TRUSTED.includes(c.author_association) && read(ASK, c.body);
    if (q && !asks[q.id]) { try { asks[q.id] = { ...question(q), url: c.html_url }; } catch { /* malformed: never shown */ } }
    const a = app && c.user?.type === 'Bot' && c.user?.login === app && read(ANSWER, c.body);
    if (a && typeof a.id === 'string' && !answers[a.id] && Number.isInteger(a.option)) answers[a.id] = { option: a.option, by: String(a.by || ''), at: String(a.at || ''), author: c.user.login, url: c.html_url };
  }
  return { asks, answers };
}

// --- GitHub ---------------------------------------------------------------------------------------
export async function api(method, path, data) {
  const r = await fetch(`${process.env.GITHUB_API_URL || 'https://api.github.com'}${path}`, {
    method,
    headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'harness-ask',
      ...(process.env.GH_TOKEN ? { authorization: `Bearer ${process.env.GH_TOKEN}` } : {}), ...(data ? { 'content-type': 'application/json' } : {}) },
    body: data ? JSON.stringify(data) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (r.status < 200 || r.status > 299) throw new Error(`${method} ${path} answered ${r.status}: ${JSON.stringify(json).slice(0, 300)}`);
  return json;
}
const comments = async (call, repo, n) => {
  const out = [];
  for (let page = 1; page <= 10; page++) { const l = await call('GET', `/repos/${repo}/issues/${n}/comments?per_page=100&page=${page}`); out.push(...l); if (l.length < 100) break; }
  return out;
};

/** Put a question on a card. The same id twice on one card is never a second question. */
export async function ask(call, { repo, issue, app = null, ...q }) {
  const qq = question(q);
  const seen = parse(await comments(call, repo, issue)).asks[qq.id];
  if (!seen) await call('POST', `/repos/${repo}/issues/${issue}/comments`, { body: askBody(qq) });
  await call('POST', `/repos/${repo}/issues/${issue}/labels`, { labels: [LABEL] });
  return { status: seen ? 'already asked' : 'asked', url: seen?.url };
}

/** Every question on an open labelled card of the owner's repositories, with its answer if any. */
export async function open(call, { owner, app, max = 100 }) {
  const found = await call('GET', `/search/issues?q=${encodeURIComponent(`user:${owner} label:${LABEL} is:open`)}&per_page=${max}`);
  const out = [];
  for (const i of found.items || []) {
    const repo = i.repository_url.split('/repos/')[1];
    const { asks, answers } = parse(await comments(call, repo, i.number), app);
    for (const q of Object.values(asks)) out.push({ repo, issue: i.number, card: i.html_url, pr: Boolean(i.pull_request), ...q, answer: answers[q.id] || null });
  }
  return out;
}

/** Write the owner's answer on the card (the hands App), then wake whoever waits. */
export async function answer(call, { repo, issue, id, option, by, at, app }) {
  if (!/^[a-z]+:\d{1,20}$/.test(String(by))) throw new Error('--by must be <channel>:<account id>');
  if (Number.isNaN(Date.parse(at))) throw new Error('--at must be a time');
  const card = await call('GET', `/repos/${repo}/issues/${issue}`);
  const { asks, answers } = parse(await comments(call, repo, issue), app);
  const q = asks[id];
  if (!q) throw new Error(`no question "${id}" on ${repo}#${issue}`);
  const n = Number(option);
  if (!Number.isInteger(n) || n < 0 || n >= q.options.length) throw new Error(`option ${option} is not one of ${q.options.length}`);
  if (answers[id]) return { status: 'already answered', option: answers[id].option };
  const a = { option: n, by: String(by), at: new Date(at).toISOString() };
  const c = await call('POST', `/repos/${repo}/issues/${issue}/comments`, { body: answerBody(q, a) });
  if (card.pull_request) return { status: 'answered', url: c.html_url, woke: `#${issue} (the pull request itself)` };
  const pr = await findChannel(call, repo).catch(() => null);
  if (!pr) return { status: 'answered', url: c.html_url, woke: null };
  await call('POST', `/repos/${repo}/issues/${pr.number}/comments`, { body: `The owner answered "${shown(q.question)}" on ${card.html_url}: ${letter(n)}. ${shown(q.options[n])}\nRead the answer there and carry on; this comment needs no reply.` });
  return { status: 'answered', url: c.html_url, woke: `#${pr.number}` };
}

/** The host: start the control repository's hands-answer job for one press. */
export const dispatch = (call, hands, a) => call('POST', `/repos/${hands}/actions/workflows/hands-answer.yml/dispatches`,
  { ref: 'main', inputs: { repo: a.repo, issue: String(a.issue), id: a.id, option: String(a.option), by: a.by, at: a.at } });

/** The host: take the label off a card whose every question is answered. */
export async function settle(call, { repo, issue, app }) {
  const { asks, answers } = parse(await comments(call, repo, issue), app);
  if (Object.keys(asks).some((id) => !answers[id])) return false;
  await call('DELETE', `/repos/${repo}/issues/${issue}/labels/${LABEL}`).catch((e) => { if (!/ 404:/.test(e.message)) throw e; });
  return true;
}

// --- command line --------------------------------------------------------------------------------
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [cmd, ...rest] = process.argv.slice(2);
  const arg = (k) => { const i = rest.indexOf(`--${k}`); return i < 0 ? undefined : rest[i + 1]; };
  const all = (k) => rest.flatMap((v, i) => (rest[i - 1] === `--${k}` ? [v] : []));
  try {
    if (cmd === 'ask') console.log(JSON.stringify(await ask(api, { repo: arg('repo'), issue: arg('issue'), id: arg('id'), question: arg('question'), options: all('option'), recommended: arg('recommended') ?? 0 })));
    else if (cmd === 'open') console.log(JSON.stringify(await open(api, { owner: arg('owner'), app: appLogin() })));
    else if (cmd === 'answer') console.log(JSON.stringify(await answer(api, { repo: arg('repo'), issue: arg('issue'), id: arg('id'), option: arg('option'), by: arg('by'), at: arg('at'), app: appLogin() })));
    else { console.error('usage: ask.mjs ask|open|answer (see the header)'); process.exit(2); }
  } catch (e) { console.error(`ask: ${e.message}`); process.exit(1); }
}
