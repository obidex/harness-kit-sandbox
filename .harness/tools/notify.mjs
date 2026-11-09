#!/usr/bin/env node
// notify — the owner's one alert standard (O10, K010): one bot, one Telegram group with topics,
// every PROBLEM closed by a RESOLVED (or STILL OPEN) reply. Every sender runs this tool. No dependencies.
//
//   node .harness/tools/notify.mjs setup        check the group, create the missing topics, pin the config
//                                               (unpinning anything pinned after it: only the config stays)
//   node .harness/tools/notify.mjs problem --key <k> --topic <t> --text <t> [--link <url>] [--title <t>]
//        [--action] [--outage] [--you <line>] [--max-sends <n>]
//                                               open a problem (a repeat of an open key sends nothing,
//                                               except a capped problem's daily repeat, below)
//   node .harness/tools/notify.mjs resolve --key <k> [--text <t>] [--quiet]
//                                               reply RESOLVED to the problem's message and close it;
//                                               --quiet closes it without any message (K038: a problem that
//                                               should never have reached the owner)
//   node .harness/tools/notify.mjs tick [--stores <spec,…>]
//                                               escalate, remind STILL OPEN once a day, send queued problems
//   node .harness/tools/notify.mjs digest [--stores <spec,…>]
//                                               post the one daily digest in "Daily"
//   node .harness/tools/notify.mjs send --topic <t> --text <t>     one plain message (silent unless "needs")
//
// Kinds (K037, S-034): what a sender reports, so the channel can change without touching senders.
//   node .harness/tools/notify.mjs needs_you --key <k> --what <t> --step <t> --where <t> --when now|today|"this week"
//        [--minutes <n>] [--link <url>]         🛑 the owner's five lines in "Needs you" (K038); several due
//                                               together go as ONE message; resolve edits it to ✅
//   node .harness/tools/notify.mjs outage --key <k> --system <name> [--who <name>]
//                                               ⚠️ one loud message; resolve edits the same message to ✅
//   node .harness/tools/notify.mjs good_news --text <t> [--key <k>] [--summary-only]
//                                               🎉 one line in "Good news" (or only in the evening summary)
//   node .harness/tools/notify.mjs ops --key <k> --text <t> [--link <url>] [--system <name>] [--who <name>]
//                                               a technical alert: the Ops board (ALERTS_OPS_BOARD), never Telegram
//   node .harness/tools/notify.mjs summary [--stores <spec,…>] [--progress <line>]… [--dry-run]
//                                               ☀️ the evening summary in "Summary"; nothing on a day with nothing to say
//   node .harness/tools/notify.mjs board        find or open the Ops board issue and print its link
//   node .harness/tools/notify.mjs note --text <t> [--link <url>]   one line on the Ops board's log (no row)
//   node .harness/tools/notify.mjs retire --topics kit,ops,daily     close topics the owner no longer keeps (K039)
//   `digest` is retired (K039): it posts nothing. `ops` on a GitHub store with no ALERTS_OPS_BOARD is
//   recorded as its issue, which a host's reader mirrors to the board.
//   The owner-facing kinds refuse a text with a path, a size, an address, a run id, an error code,
//   "You: nothing", an issue number outside a quoted paste, an alert count or a threshold (rule C), any
//   message not in the owner's format (K038: `🛑 what` / `Who:` / `Do:` / `Where:` / `When:`, five lines
//   at most), and no message carries a button.
//   node .harness/tools/notify.mjs test         a PROBLEM in "Kit & Hands" and its RESOLVED reply (a proof)
//   node .harness/tools/notify.mjs find         the bot's name and the groups it was added to, with their ids
//
// The rules (.harness/alerts.md; `problem` is the older form, kept until every sender uses a kind):
// - Topics: needs ("Needs you", the only loud one, action-required only), erp, website, kit, ops, daily.
//   --action or --outage sends to "Needs you"; every other problem goes silently to its own topic.
// - Quiet hours (23:00-08:00 Asia/Damascus): everything is silent except --outage.
// - A problem open 3 hours in a silent topic is escalated to "Needs you" (outside quiet hours, so it is
//   loud), and a STILL OPEN reply goes under the original. Every open problem gets one STILL OPEN reply a
//   day; its RESOLVED is a reply to the original message (and to the escalation, if any).
// - Dedupe: one open problem per key; a repeat only counts. Caps: at most 5 new messages per topic per
//   hour (10 in "Needs you"); the rest wait for the next tick. An outage is never capped.
// - Hold: in a host's file store a problem is sent only once it is still open 10 minutes after it was
//   first seen (ALERTS_HOLD_MINUTES), by a later `problem` call or `tick`; one resolved sooner was never
//   sent and sends nothing. A GitHub store (ticked daily) and an outage send at once.
// - Capped problems (--max-sends N, 1-10; K035): at most N messages in all, at most one a day (the
//   owner's calendar day, and 20 h since the last). The PROBLEM is the first; while it stays open, the
//   sender's own repeat call on a later day sends one STILL OPEN reply, until N (none once acknowledged or muted). Never escalated, never reminded by `tick`; past
//   N it is only a line in the daily digest until its RESOLVED. For a sender that checks the same thing
//   every day (stale work, stale data), so one stuck item cannot alert forever.
// - Format: a PROBLEM ends with one "You:" line (--you: "nothing", "<who> is fixing it" or "Needs you:
//   <exact step>"); a RESOLVED is the short reply "✅ Fixed after N min". Messages carry no commands,
//   and any time in them is the owner's time zone.
//
// Environment: ALERTS_BOT_TOKEN (or TELEGRAM_BOT_TOKEN) and the group: ALERTS_CHAT_ID, else the file
// ALERTS_CHAT_ID_FILE names, else TELEGRAM_CHAT_ID. A chat with no pinned config (a private chat, before
// setup) still gets every message, unthreaded by topic, its topic's name leading the text;
// ALERTS_STORE is where open problems are kept: `file:<path>` on a host, `github:<owner/name>` in Actions
// (one issue per problem, GH_TOKEN). Without a bot token a problem is still recorded, unsent, for the
// next tick to send; ALERTS_REQUIRE_SEND=1 makes that an error instead. The topic ids live in a pinned
// message in the group, written by setup, so senders need only the token and the chat id.

import { readFileSync, writeFileSync, mkdirSync, rmdirSync, existsSync, renameSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TOPICS = {
  needs: { name: 'Needs you', color: 0xFF93B2 },
  good: { name: 'Good news', color: 0x8EEE98 },
  summary: { name: 'Summary', color: 0xFFD67E },
  erp: { name: 'ERP', color: 0x6FB9F0 },
  website: { name: 'Website', color: 0x8EEE98 },
  kit: { name: 'Kit & Hands', color: 0xCB86DB },
  ops: { name: 'Laptop & VPS', color: 0xFFD67E },
  daily: { name: 'Daily', color: 0xFB6F5F },
};
export const CONFIG_MARK = 'harness-alerts config';
const NEW_TOPICS = ['good', 'summary']; // K037: until setup runs again they reach General, named
const HOUR = 3600e3;
const REPEAT_GAP = 20 * 3600e3; // a capped problem's repeats: a new day and at least this long since its last message
const env = (k, d) => process.env[k] ?? d;
export const rules = () => ({
  tz: env('ALERTS_TZ', 'Asia/Damascus'),
  quiet: env('ALERTS_QUIET', '23-8').split('-').map(Number),
  escalateAfter: Number(env('ALERTS_ESCALATE_MINUTES', 180)) * 60e3,
  remindEvery: 24 * HOUR,
  cap: Number(env('ALERTS_CAP', 5)),
  capNeeds: Number(env('ALERTS_CAP_NEEDS', 10)),
});
/** How long a new problem in this store waits, still open, before it is sent (0 = at once). */
const holdOf = (st) => (!st.hold ? 0 : env('ALERTS_HOLD_MINUTES') ? Number(env('ALERTS_HOLD_MINUTES')) * 60e3 : st.hold);
/** The one "You:" line of a PROBLEM: what the owner does about it. */
export const YOU = /^(nothing|\S.* is fixing it|Needs you: \S.*)$/;
const youOf = (inc) => inc.you || (inc.topic === 'needs' ? 'Needs you: see the message above' : 'nothing');
export const now = () => (process.env.ALERTS_NOW ? new Date(process.env.ALERTS_NOW).getTime() : Date.now());

/** The local hour in the owner's time zone. */
export const localHour = (t, tz = rules().tz) => Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: tz }).format(new Date(t)));
/** A time as the owner reads it: "2026-10-05 09:41" in his time zone (messages carry no other). */
export const localTime = (t, tz = rules().tz) => new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeStyle: 'short', hourCycle: 'h23', timeZone: tz }).format(new Date(t));
/** True inside quiet hours (a window that may cross midnight). */
export function isQuiet(t, r = rules()) {
  const h = localHour(t, r.tz); const [from, to] = r.quiet;
  return from > to ? h >= from || h < to : h >= from && h < to;
}
/** Loud only for an outage, or for "Needs you" outside quiet hours. */
export const loud = (topic, outage, t, r = rules()) => !!outage || (topic === 'needs' && !isQuiet(t, r));
const age = (ms) => { const m = Math.round(ms / 60e3); return m < 60 ? `${m} min` : m < 2880 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.round(m / 1440)} days`; };
const one = (s) => String(s ?? '').replace(/\s*\n\s*/g, ' ').trim();
/** The owner's calendar day of a time ("2026-11-07"): a capped problem sends at most once a day. */
export const dayOf = (t, tz = rules().tz) => localTime(t, tz).slice(0, 10);
/** The --max-sends value: an integer 1-10, or undefined for an uncapped problem. */
export function maxSendsOf(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 10) throw new Error(`--max-sends is a whole number from 1 to 10, not "${v}"`);
  return n;
}

// --- Telegram -------------------------------------------------------------------------------------
const chatId = () => env('ALERTS_CHAT_ID') || (env('ALERTS_CHAT_ID_FILE') && existsSync(env('ALERTS_CHAT_ID_FILE')) ? readFileSync(env('ALERTS_CHAT_ID_FILE'), 'utf8').trim() : '') || env('TELEGRAM_CHAT_ID');
export function telegram({ token = env('ALERTS_BOT_TOKEN') || env('TELEGRAM_BOT_TOKEN'), chat = chatId(), base = env('ALERTS_API', 'https://api.telegram.org') } = {}) {
  const call = async (method, params, retry = true) => {
    if (!token || !chat) throw new Error('ALERTS_BOT_TOKEN and ALERTS_CHAT_ID are not both set');
    let r;
    try { r = await fetch(`${base}/bot${token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params) }); }
    catch (e) { throw new Error(`Telegram ${method}: ${e.cause?.code || e.message}`); } // never echo the URL: it holds the token
    const j = await r.json().catch(() => ({}));
    if (j.ok) return j.result;
    if (r.status === 429 && retry) { await new Promise((ok) => setTimeout(ok, Math.min(30, j.parameters?.retry_after || 3) * 1000)); return call(method, params, false); }
    throw new Error(`Telegram ${method}: ${r.status} ${j.description || ''}`.trim());
  };
  let topics;
  // the topic's thread, or General with the topic's name leading the text: before setup (no config), and for a
  // topic K037 added that the group has not created yet (setup adds it); any other missing topic is an error, as before
  const where = async (topic, text) => {
    const ids = await tg.topics();
    if (ids[topic]) return { message_thread_id: ids[topic], text };
    if (Object.keys(ids).length && !NEW_TOPICS.includes(topic)) throw new Error(`unknown topic "${topic}" (known: ${Object.keys(ids).join(', ')})`);
    return { text: `[${TOPICS[topic]?.name || topic}] ${text}` };
  };
  const tg = {
    ready: !!(token && chat),
    chat,
    call,
    /** The topic ids: ALERTS_TOPICS (JSON) or the pinned config message setup wrote; {} when there is none. */
    async topics() {
      if (topics) return topics;
      if (env('ALERTS_TOPICS')) return (topics = JSON.parse(env('ALERTS_TOPICS')));
      const c = await call('getChat', { chat_id: chat });
      const text = c.pinned_message?.text || '';
      if (!text.startsWith(CONFIG_MARK)) { console.error('notify: this chat has no pinned alerts config (setup not run): sending without topics'); return (topics = {}); }
      return (topics = JSON.parse(text.slice(text.indexOf('{'))).topics);
    },
    /** Send to a topic; returns the message id. */
    async send(topic, text, { reply, outage, t = now() } = {}) {
      const m = await call('sendMessage', {
        chat_id: chat, ...await where(topic, text), link_preview_options: { is_disabled: true },
        disable_notification: !loud(topic, outage, t),
        ...(reply ? { reply_parameters: { message_id: reply, allow_sending_without_reply: true } } : {}),
      });
      return m.message_id;
    },
    /** Edit a sent message in place (Telegram never notifies an edit). */
    async edit(topic, msg, text) {
      const w = await where(topic, text);
      await call('editMessageText', { chat_id: chat, message_id: msg, text: w.text, link_preview_options: { is_disabled: true } });
    },
    async link(topic, msg) { const ids = await tg.topics(); return ids[topic] ? `https://t.me/c/${String(chat).replace(/^-100/, '')}/${ids[topic]}/${msg}` : `message ${msg} in this chat`; },
  };
  return tg;
}

// --- stores: where open problems live ---------------------------------------------------------------
// An incident: { key, topic, text, title, link, outage, opened, sentAt, msg, escalated, escMsg, remindedAt, count, open, closed,
//   maxSends, sends, sentDay }  (the last three only on a capped problem)
function fileStore(path) {
  const lock = `${path}.lock`;
  const read = () => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { incidents: {} });
  const write = (s) => {
    for (const [k, v] of Object.entries(s.incidents)) if (!v.open && now() - v.closed > 7 * 24 * HOUR) delete s.incidents[k];
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(`${path}.tmp`, `${JSON.stringify(s, null, 2)}\n`); renameSync(`${path}.tmp`, path);
  };
  return {
    name: `file:${path}`,
    news: true, // keeps good-news and summary records for the evening summary
    hold: 10 * 60e3, // a host checks every few minutes and ticks itself: a flap is never sent
    async locked(fn) {
      mkdirSync(dirname(path), { recursive: true });
      for (let i = 0; ; i++) {
        try { mkdirSync(lock); break; } catch { if (i > 100) throw new Error(`${lock} is held; remove it if no sender is running`); await new Promise((ok) => setTimeout(ok, 100)); }
      }
      try { return await fn(); } finally { rmdirSync(lock); }
    },
    async list() { return Object.values(read().incidents); },
    async get(key) { const i = read().incidents[key]; return i?.open ? i : null; },
    async save(inc) { const s = read(); s.incidents[inc.key] = inc; write(s); },
    async note() {},
    async close(inc) { const s = read(); s.incidents[inc.key] = inc; write(s); },
  };
}

/** The GitHub REST API with GH_TOKEN (or GITHUB_TOKEN); errors name the call, never the token. */
const ghApi = () => {
  const base = env('GITHUB_API_URL', 'https://api.github.com');
  return async (method, path, data) => {
    const r = await fetch(`${base}${path}`, { method, headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${env('GH_TOKEN') || env('GITHUB_TOKEN')}`, 'x-github-api-version': '2022-11-28', 'content-type': 'application/json' }, body: data ? JSON.stringify(data) : undefined });
    const j = r.status === 204 ? {} : await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`GitHub ${method} ${path}: ${r.status} ${j.message || ''}`.trim());
    return j;
  };
};

function githubStore(repo) {
  const gh = ghApi();
  const MARK = /<!-- harness-alert: (\{.*?\}) -->/;
  const decode = (issue) => { const m = (issue.body || '').match(MARK); return m ? { ...JSON.parse(m[1]), issue: issue.number, url: issue.html_url } : null; };
  const encode = (inc) => { const { issue, url, ...rest } = inc; return `<!-- harness-alert: ${JSON.stringify(rest).replaceAll('-->', '--\\u003e')} -->`; };
  const bodyOf = (inc) => [encode(inc), `**${inc.outage ? 'OUTAGE' : 'PROBLEM'}:** ${one(inc.text)}`, inc.link ? `\n${inc.link}` : '', '',
    'Kept by the Harness Kit alert standard (`.harness/alerts.md`): the Telegram message, its RESOLVED reply and escalation follow this issue. Close it with `notify.mjs resolve`, not by hand.'].join('\n');
  const issues = async (q) => { const out = []; for (let p = 1; p < 10; p++) { const page = await gh('GET', `/repos/${repo}/issues?per_page=100&page=${p}&${q}`); out.push(...page.filter((i) => !i.pull_request)); if (page.length < 100) break; } return out; };
  return {
    name: `github:${repo}`,
    async locked(fn) { return fn(); }, // callers serialize with a concurrency group
    async list() {
      const since = new Date(now() - 2 * 24 * HOUR).toISOString();
      const all = [...await issues('state=open'), ...await issues(`state=closed&since=${since}`)];
      return all.map(decode).filter(Boolean);
    },
    async get(key) { return (await issues('state=open')).map(decode).find((i) => i && i.key === key && i.open) || null; },
    async save(inc) {
      if (inc.issue) { await gh('PATCH', `/repos/${repo}/issues/${inc.issue}`, { body: bodyOf(inc) }); return; }
      const i = await gh('POST', `/repos/${repo}/issues`, { title: inc.title || `Alert: ${one(inc.text).slice(0, 80)}`, body: bodyOf(inc) });
      inc.issue = i.number; inc.url = i.html_url;
    },
    async note(inc, text) { if (inc.issue) await gh('POST', `/repos/${repo}/issues/${inc.issue}/comments`, { body: text }); },
    async close(inc, text) {
      await gh('POST', `/repos/${repo}/issues/${inc.issue}/comments`, { body: text });
      await gh('PATCH', `/repos/${repo}/issues/${inc.issue}`, { body: bodyOf(inc), state: 'closed', state_reason: 'completed' });
    },
  };
}

export function store(spec = env('ALERTS_STORE')) {
  if (!spec) throw new Error('ALERTS_STORE is not set (file:<path> or github:<owner/name>)');
  const [kind, ...rest] = spec.split(':'); const where = rest.join(':');
  if (kind === 'file' && where) return fileStore(resolve(where));
  if (kind === 'github' && /^[\w.-]+\/[\w.-]+$/.test(where)) return githubStore(where);
  throw new Error(`ALERTS_STORE "${spec}" is not file:<path> or github:<owner/name>`);
}

// --- the rules --------------------------------------------------------------------------------------
const headline = (inc) => `${inc.outage ? '🚨 OUTAGE' : inc.topic === 'needs' ? '🔴 NEEDS YOU' : '🔴 PROBLEM'} · ${one(inc.text)}${inc.link ? `\n${inc.link}` : ''}\nYou: ${youOf(inc)}`;
const fixed = (inc, t) => `✅ Fixed after ${age(t - inc.opened)}`;
/** A held problem is due once it has been open the store's hold; an outage never waits. */
const due = (st, inc, t) => inc.outage || t - inc.opened >= holdOf(st);

/** Messages sent in the last hour to a topic, from what the store remembers. */
const sentLastHour = (list, topic, t) => list.filter((i) => i.topic === topic && i.sentAt && t - i.sentAt < HOUR).length
  + list.filter((i) => i.escMsg && i.escalated && t - i.escalated < HOUR && topic === 'needs').length;
const capped = (list, inc, t, r) => !inc.outage && sentLastHour(list, inc.topic, t) >= (inc.topic === 'needs' ? r.capNeeds : r.cap);

/** A topic the owner no longer keeps is closed (K039). A problem still sent there moves to the Ops board:
 * it becomes an ops row (its old message, if any, is left as it was), so nothing is retried or escalated. */
const topicClosed = (e) => /TOPIC_CLOSED/.test(e?.message || '');
function toOps(inc, t) {
  Object.assign(inc, { kind: 'ops', retiredTopic: inc.topic, topic: null, movedAt: t, ...(inc.msg ? { legacyMsg: inc.msg } : {}) });
  inc.msg = null; delete inc.escalated; delete inc.maxSends;
  return true;
}
async function sendProblem(tg, inc, list, t, r) {
  if (!tg.ready || capped(list, inc, t, r)) return false;
  try { inc.msg = await tg.send(inc.topic, headline(inc), { outage: inc.outage, t }); } catch (e) { if (topicClosed(e)) return toOps(inc, t); throw e; }
  inc.sentAt = t;
  if (inc.maxSends) { inc.sends = 1; inc.sentDay = dayOf(t, r.tz); }
  return true;
}

/** A capped problem's repeat: one STILL OPEN reply on a new day while under its cap; true when sent. */
async function sendRepeat(tg, inc, t, r) {
  const sends = inc.sends || 1;
  // a new day in the owner's time zone AND 20 h since the last send: a PROBLEM at 23:50 is not followed at 00:00;
  // an acknowledged or muted problem (control panel, K025) is never reminded
  if (!tg.ready || !inc.msg || sends >= inc.maxSends || inc.sentDay === dayOf(t, r.tz) || t - (inc.remindedAt || inc.sentAt || 0) < REPEAT_GAP || hushed(inc, t)) return false;
  const n = sends + 1, last = n >= inc.maxSends;
  try { await tg.send(inc.topic, `🟠 STILL OPEN after ${age(t - inc.opened)} (alert ${n} of ${inc.maxSends}${last ? ', the last: from now on only a line in the daily digest until it clears' : ''}) · ${one(inc.text)}`, { reply: inc.msg, t }); }
  catch (e) { if (topicClosed(e)) return toOps(inc, t); throw e; }
  inc.sends = n; inc.sentDay = dayOf(t, r.tz); inc.remindedAt = t;
  return true;
}

export async function problem(st, tg, o) {
  const r = rules(), t = now();
  if (!o.key || !o.text) throw new Error('--key and --text are required');
  if (o.you && !YOU.test(one(o.you))) throw new Error('--you is "nothing", "<who> is fixing it" or "Needs you: <exact step>"');
  const topic = o.outage || o.action ? 'needs' : o.topic;
  if (!topic) throw new Error('--topic is required (needs, erp, website, kit, ops, or another set up topic)');
  const maxSends = maxSendsOf(o.maxSends);
  if (maxSends && (o.outage || topic === 'needs')) throw new Error('--max-sends is for a silent topic\'s problem, never an outage or "Needs you"');
  return st.locked(async () => {
    const open = await st.get(o.key);
    if (open) {
      open.count = (open.count || 1) + 1; open.lastSeen = t;
      if (open.maxSends) open.text = one(o.text); // a capped repeat says how it stands now (its age moves)
      await st.save(open);
      if (o.link && !open.maxSends) await st.note(open, `Still failing: ${o.link}`);
      if (open.kind) return { status: 'repeat', inc: open }; // moved to the Ops board (its topic is closed): the tick keeps its row
      if (!open.msg && tg.ready && due(st, open, t)) { const list = await st.list(); if (await sendProblem(tg, open, list, t, r)) { await st.save(open); return { status: 'repeat', inc: open }; } }
      if (open.maxSends && await sendRepeat(tg, open, t, r)) { await st.save(open); await st.note(open, `STILL OPEN: alert ${open.sends} of ${open.maxSends} sent.`); return { status: 'reminded', inc: open }; }
      if (open.maxSends && open.msg && (open.sends || 1) >= open.maxSends) return { status: 'capped-out', inc: open };
      return { status: open.msg || due(st, open, t) ? 'repeat' : 'held', inc: open };
    }
    const inc = { key: o.key, topic, text: one(o.text), title: o.title, link: o.link, outage: !!o.outage, ...(o.you ? { you: one(o.you) } : {}), ...(maxSends ? { maxSends, sends: 0 } : {}), opened: t, msg: null, count: 1, open: true };
    const list = await st.list();
    let sent = false, err;
    const now0 = due(st, inc, t);
    if (now0) try { sent = await sendProblem(tg, inc, list, t, r); } catch (e) { err = e; }
    await st.save(inc);
    if (err) throw err;
    return { status: inc.kind === 'ops' ? 'moved to the Ops board' : sent ? 'sent' : !now0 ? 'held' : tg.ready ? 'capped' : 'queued', inc };
  });
}

export async function resolveKey(st, tg, o, board) {
  const t = now();
  return st.locked(async () => {
    const inc = await st.get(o.key);
    if (!inc) return { status: 'none' };
    if (inc.kind) return resolveKind(st, tg, inc, o, t, board === undefined && ['ops', 'outage'].includes(inc.kind) ? boardOrNull() : board);
    const text = fixed(inc, t);
    if (inc.msg && !o.quiet) {
      // a topic the owner no longer keeps is closed (K039): its old problems close without a reply
      const closedTopic = (e) => { if (!/TOPIC_CLOSED/.test(e.message)) throw e; };
      await tg.send(inc.topic, text, { reply: inc.msg, t }).catch(closedTopic);
      if (inc.escMsg) await tg.send('needs', text, { reply: inc.escMsg, t }).catch(closedTopic);
    }
    // a resolved problem never stays pinned (owner, 2026-10-06); a message that was not pinned is no error
    for (const id of [inc.msg, inc.escMsg].filter(Boolean)) await tg.call('unpinChatMessage', { chat_id: tg.chat, message_id: id }).catch(() => {});
    inc.open = false; inc.closed = t; inc.resolution = one(o.text || '');
    await st.close(inc, `RESOLVED after ${age(t - inc.opened)}${o.text ? `: ${one(o.text)}` : '.'}`);
    return { status: inc.msg ? (o.quiet ? 'closed-quietly' : 'resolved') : 'closed-unsent', inc };
  });
}

/** A kind ends with ✅ where it began: the owner's message is edited in place (silent, never a second
 * message); an ops or outage row on the board turns ✅ with one resolve comment. */
async function resolveKind(st, tg, inc, o, t, board) {
  const mates = inc.batch ? (await st.list()).filter((i) => i.key !== inc.key && inc.batch.includes(i.key) && i.msg === inc.msg) : [];
  if (inc.msg && mates.some((i) => i.open)) { /* one message for several: it turns ✅ when the last of them is sorted */ }
  else if (inc.msg) {
    const done = inc.kind === 'outage' ? TEMPLATES.outage_fixed(inc, t) : inc.batch && inc.batch.length > 1 ? TEMPLATES.needs_you_batch_done(inc.batch) : TEMPLATES.needs_you_done(inc);
    await tg.edit(inc.topic, inc.msg, done);
    await tg.call('unpinChatMessage', { chat_id: tg.chat, message_id: inc.msg }).catch(() => {});
  }
  // a problem moved from a closed topic (K039) whose old escalation is in Needs you: that message turns ✅ too
  if (inc.retiredTopic && inc.escMsg) await tg.edit('needs', inc.escMsg, fixed(inc, t)).catch((e) => console.error(`notify: ${e.message}`));
  inc.open = false; inc.closed = t; inc.resolution = one(o.text || '');
  await boardSync(board, inc, t);
  await st.close(inc, `RESOLVED after ${age(t - inc.opened)}${o.text ? `: ${one(o.text)}` : '.'}`);
  return { status: delivered(inc) ? 'resolved' : 'closed-unsent', inc };
}

/** The control panel's Acknowledge and Mute (K025): an acknowledged problem is never escalated or
 * reminded; a muted one not until `mutedUntil`. Its RESOLVED still goes out. For a file store (its lock
 * holds across processes); a GitHub store's lock is its senders' concurrency group, so a host outside it
 * must not call this. */
export async function hush(st, key, { ack, mutedUntil } = {}) {
  return st.locked(async () => {
    const inc = await st.get(key);
    if (!inc) return { status: 'none' };
    if (ack !== undefined) inc.ack = !!ack;
    if (mutedUntil !== undefined) inc.mutedUntil = mutedUntil === null ? null : Number(mutedUntil);
    await st.save(inc);
    return { status: 'hushed', inc };
  });
}
const hushed = (inc, t) => !!inc.ack || (inc.mutedUntil && inc.mutedUntil > t);

// --- kinds (K037, S-034): the owner's group gets only what matters to him; technical alerts go to the Ops board ---
export const KINDS = ['needs_you', 'outage', 'good_news', 'summary', 'ops'];
const KIND_TOPIC = { needs_you: 'needs', outage: 'needs', good_news: 'good', summary: 'summary' };
const hhmm = (t) => localTime(t).slice(11);
/** The Ops board, or null; a malformed ALERTS_OPS_BOARD is logged, never a stop for the rest of a tick. */
const boardOrNull = () => { try { return opsBoard(); } catch (e) { console.error(`notify: ${e.message}`); return null; } };
/** Every owner-facing message the kinds send, in one place (the template test reads these). */
export const TEMPLATES = {
  needs_you: (i) => [`🛑 ${i.what}`, 'Who: you', `Do: ${i.step}${i.minutes ? ` (about ${i.minutes} min)` : ''}`,
    `Where: ${i.where}${i.link ? ` ${i.link}` : ''}`, `When: ${i.when}`].join('\n'),
  // several due together: ONE message (owner, roadmap #59, 8 Nov 2026), each step numbered in its Do line
  needs_you_batch: (list) => [`🛑 ${list.length} things need you: ${list.map((i) => i.what.replace(/[.!]$/, '')).join('; ')}.`, 'Who: you',
    `Do: ${list.map((i, n) => `${n + 1}) ${i.step}${i.minutes ? ` (about ${i.minutes} min)` : ''}`).join(' ')}`,
    `Where: ${[...new Set(list.map((i) => i.where))].join('; ')}`, `When: ${WHEN.find((w) => list.some((i) => i.when === w))}`].join('\n'),
  needs_you_done: (i) => [`✅ Sorted: ${i.what}`, 'Do: nothing'].join('\n'),
  needs_you_batch_done: (list) => [`✅ Sorted: ${list.length} things that needed you`, 'Do: nothing'].join('\n'),
  outage: (i) => [`⚠️ ${i.system} is down since ${hhmm(i.opened)}`, `Who: ${i.who}`, 'Do: nothing', 'When: now'].join('\n'),
  outage_fixed: (i, t) => [`✅ ${i.system} was down ${age(t - i.opened)}. Fixed.`, 'Do: nothing'].join('\n'),
  good_news: (i) => [`🎉 ${i.text}`, 'Do: nothing'].join('\n'),
  // the evening summary in the same five lines: what happened today, who, his one action (or nothing)
  summary: ({ date, live, progress, needs, board }) => [
    `☀️ ${date}: ${[live.length ? `went live: ${live.map((x) => x.replace(/[.!]$/, '')).join('; ')}` : '', progress.length ? `in progress: ${progress.join('; ')}` : ''].filter(Boolean).join('. ') || 'nothing new'}.`,
    `Who: ${needs.length ? 'you' : 'Platform'}`,
    `Do: ${needs.length ? `${needs[0]}${needs.length > 1 ? ` (and ${needs.length - 1} more in Needs you)` : ''}` : 'nothing'}`,
    ...(needs.length ? ['Where: the Needs you topic'] : board ? [`Where: ${board}`] : []),
    ...(needs.length ? ['When: today'] : []),
  ].join('\n'),
};
/** When an owner step is due, soonest first. */
export const WHEN = ['now', 'today', 'this week'];
/** The owner's format (roadmap #59, 8 Nov 2026; K038): at most five lines, the first an emoji and what
 * happened in plain words, then only the labelled lines Who:, Do:, Where:, When:, in that order, with Do:
 * always there. A "Who:" that is not him means it was never his: senders send those to the Ops board. */
export function formatProblems(text) {
  const lines = String(text ?? '').split('\n'), p = [];
  if (lines.length > 5) p.push(`${lines.length} lines (five at most)`);
  if (!/^\p{Extended_Pictographic}\uFE0F? \S/u.test(lines[0] || '')) p.push('a first line that is not an emoji and what happened');
  const labels = lines.slice(1).map((l) => (l.match(/^(Who|Do|Where|When): \S/) || [])[1] || null);
  if (labels.some((l) => !l)) p.push('a line after the first that is not Who:, Do:, Where: or When:');
  const order = ['Who', 'Do', 'Where', 'When'], got = labels.filter(Boolean);
  if (got.some((l, i) => i && order.indexOf(l) <= order.indexOf(got[i - 1]))) p.push('the labelled lines out of order (Who, Do, Where, When) or twice');
  if (!got.includes('Do')) p.push('no Do: line');
  const when = lines.find((l) => l.startsWith('When: '));
  if (when && !WHEN.includes(when.slice(6))) p.push('a When: that is not now, today or this week');
  return p;
}
/** Rule C: what an owner-facing message never carries. Links are allowed (a link opens the page where his step is). */
export const NOT_PLAIN = [
  [/(^|[\s(:'"])~?\/[\w.-]+\/[\w./-]*/, 'a filesystem path'],
  [/\b[\w-]+\.(sh|mjs|cjs|py|json|ya?ml|log|conf|env|service|timer)\b/i, 'a file name'], // not .js: "Next.js" is a product name
  [/\b\d+(\.\d+)?\s?(B|KB|MB|GB|TB|KiB|MiB|GiB|TiB)\b/, 'a size'],
  [/\b\d{1,3}(\.\d{1,3}){3}\b/, 'an address'],
  [/\b[\w-]+\.(internal|local|lan|home\.arpa)\b/i, 'a host name'],
  [/\b\d{8,}\b/, 'a run or message id'],
  [/\b(exit (code |status )?\d+|HTTP \d{3}|E(CONN\w+|NOENT|ACCES|PERM|TIMEDOUT|ADDRINUSE|NOTFOUND))\b/i, 'an error code'],
  [/\bYou: nothing\b/i, '"You: nothing"'],
  [/\balert \d+ of \d+\b/i, 'an alert count'],
  [/\bthreshold\b/i, 'a threshold'],
  [/\bResume it or record why it waits\b/i, 'an instruction meant for an agent'],
];
/** A repository or issue number (#12, name#12, owner/name#12) is refused outside a quoted paste ("…" or “…”). */
const NUMBER = /(^|[^\w&])#\d+\b|\b[\w.-]+(\/[\w.-]+)?#\d+\b/;
/** The rule-C problems in a text meant for the owner (links stripped first); [] when it is plain. */
export const plainProblems = (text) => {
  const s = String(text ?? '').replace(/https?:\/\/\S+/g, '');
  const p = NOT_PLAIN.filter(([re]) => re.test(s)).map(([, what]) => what);
  if (NUMBER.test(s.replace(/"[^"\n]*"|“[^”\n]*”/g, '""'))) p.push('a repository or issue number');
  return p;
};
const mustBePlain = (kind, text) => {
  const p = plainProblems(text);
  if (p.length) throw new Error(`${kind}: the owner's message carries ${p.join(', ')}: say it in business words (the technical part goes to the Ops board)`);
  const f = formatProblems(text);
  if (f.length) throw new Error(`${kind}: the owner's message is not in his format (${f.join('; ')}): 🛑 what / Who: / Do: / Where: / When:`);
};
/** A board or comment text never notifies anyone on GitHub: no @mention survives. */
const noMention = (s) => String(s ?? '').replace(/@(?=[A-Za-z0-9])/g, '@​');
const cell = (s) => noMention(one(s)).replaceAll('|', '\\|');

/** The Ops board (A): one GitHub issue, its body a live board, one comment per problem and per resolve. */
export function opsBoard(spec = env('ALERTS_OPS_BOARD')) {
  if (!spec) return null;
  const repo = spec.replace(/^github:/, '');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`ALERTS_OPS_BOARD "${spec}" is not github:<owner/name>`);
  const gh = ghApi();
  const MARK = /^<!-- harness-ops-board: (\{.*?\}) -->/;
  let issue;
  const find = async (create) => {
    if (issue) return issue;
    for (let p = 1; p < 10 && !issue; p++) {
      const page = await gh('GET', `/repos/${repo}/issues?state=open&per_page=100&page=${p}`);
      issue = page.filter((i) => !i.pull_request && MARK.test(i.body || '')).sort((a, b) => a.number - b.number)[0];
      if (page.length < 100) break;
    }
    if (!issue && create) issue = await gh('POST', `/repos/${repo}/issues`, { title: 'Ops board', body: render({ rows: {} }) });
    return issue;
  };
  const render = (b, t = now()) => {
    const rows = Object.entries(b.rows).sort(([, x], [, y]) => (x.state === '✅') - (y.state === '✅') || y.since - x.since);
    return [`<!-- harness-ops-board: ${JSON.stringify(b).replaceAll('-->', '--\\u003e')} -->`,
      '**Ops board.** Technical alerts for the agents, kept by `notify.mjs` (`.harness/alerts.md`, K037): this body is the live state, each comment one problem or one resolve. Nothing here goes to the owner\'s Telegram.', '',
      rows.length ? '| | What | Since | Who is on it | Now |\n|---|---|---|---|---|' : 'Nothing open.',
      ...rows.map(([k, r]) => `| ${r.state} | ${cell(r.system || k)} | ${localTime(r.since)} | ${cell(r.who || '')} | ${cell(r.text)} |`),
      '', `Updated ${localTime(t)} (${rules().tz}).`].join('\n');
  };
  return {
    repo,
    async url(create = false) { return (await find(create))?.html_url || null; },
    async issue(create = false) { return find(create); },
    /** Pin the board in its repository (GraphQL pinIssue; a board already pinned is no error). Run as the
     * bot or App that opened it (`notify.mjs board --open`), never with the owner's own token (S-034 A). */
    async pin() {
      const i = await find(true);
      const j = await gh('POST', '/graphql', { query: 'mutation($id:ID!){pinIssue(input:{issueId:$id}){issue{isPinned}}}', variables: { id: i.node_id } });
      if (j.errors?.length && !j.errors.every((e) => /already pinned/i.test(e.message || ''))) throw new Error(`GitHub pinIssue: ${j.errors.map((e) => e.message).join('; ')}`);
      return i.html_url;
    },
    /** One comment on the board's log, no row. */
    async note(line) { const i = await find(true); await gh('POST', `/repos/${repo}/issues/${i.number}/comments`, { body: noMention(line) }); },
    /** One row changes state, and its comment is the log line. */
    async post(inc, state, line) {
      const i = await find(true);
      const fresh = await gh('GET', `/repos/${repo}/issues/${i.number}`);
      const b = (fresh.body || '').match(MARK) ? JSON.parse(fresh.body.match(MARK)[1]) : { rows: {} };
      const t = now();
      for (const [k, r] of Object.entries(b.rows)) if (r.state === '✅' && t - r.since > 7 * 24 * HOUR) delete b.rows[k];
      b.rows[inc.key] = { state, since: t, system: noMention(inc.system || '') || undefined, who: state === '✅' ? '' : noMention(inc.who || 'Platform'), text: noMention(inc.text) };
      await gh('POST', `/repos/${repo}/issues/${i.number}/comments`, { body: noMention(line) });
      await gh('PATCH', `/repos/${repo}/issues/${i.number}`, { body: render(b, t) });
    },
  };
}
const boardOpenLine = (inc) => `${inc.kind === 'outage' ? '🛑 outage' : '⚠️ problem'} · \`${inc.key}\` · ${one(inc.text)}${inc.link ? `\n${inc.link}` : ''}`;
const boardCloseLine = (inc, t) => `✅ resolved after ${age(t - inc.opened)} · \`${inc.key}\`${inc.resolution ? ` · ${inc.resolution}` : ''}`;
/** Put an open (or just closed) kind on the board; a failure is retried by tick. */
async function boardSync(board, inc, t) {
  if (!board || !['ops', 'outage'].includes(inc.kind)) return false;
  try {
    if (inc.open && !inc.boarded) { await board.post(inc, inc.kind === 'outage' ? '🛑' : '⚠️', boardOpenLine(inc)); inc.boarded = t; return true; }
    if (!inc.open && inc.boarded && !inc.boardClosed) { await board.post(inc, '✅', boardCloseLine(inc, inc.closed)); inc.boardClosed = t; return true; }
  } catch (e) { console.error(`notify: the Ops board: ${e.message} (tick tries again)`); }
  return false;
}

/** Deliver a due kind: a Telegram message for the owner's kinds, a board entry for ops; true when it went out. */
async function deliver(st, tg, board, inc, list, t, r) {
  if (inc.kind === 'ops') return boardSync(board, inc, t);
  await boardSync(board, inc, t); // an outage's board row does not wait for Telegram
  if (!tg.ready || capped(list, inc, t, r)) return false;
  inc.msg = await tg.send(inc.topic, inc.message, { outage: inc.outage, t }); inc.sentAt = t;
  return true;
}
const delivered = (inc) => (inc.kind === 'ops' ? !!inc.boarded : !!inc.msg);

/** Open Needs you items already due and not yet sent. */
const waitingNeeds = (st, list, t) => list.filter((i) => i.kind === 'needs_you' && i.open && !i.msg && due(st, i, t));
/** Several Needs you due together go as ONE message (owner, roadmap #59): each remembers it and the
 * batch, so resolving one stays silent until the last of them, which edits the message to ✅. */
async function deliverNeeds(st, tg, items, list, t, r) {
  if (items.length === 1) return deliver(st, tg, null, items[0], list, t, r);
  items.sort((a, b) => a.opened - b.opened);
  if (!tg.ready || capped(list, items[0], t, r)) return false;
  const text = TEMPLATES.needs_you_batch(items);
  // each item passed rule C on its own; a joined text that reads otherwise (quotes pairing across items)
  // must not stop the store's tick: then each goes alone, as it would have before
  if (plainProblems(text).length || formatProblems(text).length) {
    let any = false;
    for (const i of items) any = (await deliver(st, tg, null, i, list, t, r)) || any;
    return any;
  }
  const msg = await tg.send('needs', text, { t });
  // one message counts once against the hourly cap: only the first carries sentAt
  items.forEach((i, n) => { i.msg = msg; if (n === 0) i.sentAt = t; else i.batchedAt = t; i.batch = items.map((x) => x.key); });
  return true;
}

/** Raise one kind (needs_you, outage, good_news, ops). A repeat of an open key sends nothing. */
export async function raise(st, tg, o, board = opsBoard()) {
  const r = rules(), t = now(), kind = o.kind;
  if (!KINDS.includes(kind) || kind === 'summary') throw new Error(`unknown kind "${kind}" (needs_you, outage, good_news, ops; the summary is its own command)`);
  if (kind === 'good_news') return goodNews(st, tg, o, t);
  if (!o.key) throw new Error('--key is required');
  const inc = { key: o.key, kind, topic: KIND_TOPIC[kind] || null, opened: t, msg: null, count: 1, open: true, ...(o.link ? { link: o.link } : {}) };
  if (kind === 'needs_you') {
    for (const f of ['what', 'step', 'where', 'when']) if (!o[f]) throw new Error('needs_you needs --what, --step, --where and --when: what is wrong, his exact action, the exact place, now/today/this week');
    if (!WHEN.includes(one(o.when))) throw new Error('--when is now, today or "this week"');
    if (o.minutes !== undefined && !(Number.isInteger(Number(o.minutes)) && Number(o.minutes) > 0)) throw new Error('--minutes is a whole number of minutes');
    Object.assign(inc, { what: one(o.what), step: one(o.step), where: one(o.where), when: one(o.when), ...(o.minutes ? { minutes: Number(o.minutes) } : {}) });
    inc.text = inc.what;
  } else if (kind === 'outage') {
    if (!o.system) throw new Error('outage needs --system: what users notice is down, in their words ("Website", "ERP")');
    Object.assign(inc, { system: one(o.system), who: one(o.who || 'Platform'), outage: true });
    inc.text = `${inc.system} is down`;
  } else { // ops
    if (!o.text) throw new Error('ops needs --text');
    // without a board, a GitHub store's issue is the record (a reader such as a host's alerts job mirrors it
    // to the board, K039); a host's file store with no board would keep it where no agent reads it
    if (!board && !st.name.startsWith('github:')) throw new Error('ALERTS_OPS_BOARD is not set (github:<owner/name>): a technical alert has nowhere to go');
    Object.assign(inc, { text: one(o.text), ...(o.system ? { system: one(o.system) } : {}), ...(o.who ? { who: one(o.who) } : {}) });
  }
  if (kind !== 'ops') { inc.message = TEMPLATES[kind](inc); mustBePlain(kind, inc.message); }
  return st.locked(async () => {
    const open = await st.get(o.key);
    if (open) {
      open.count = (open.count || 1) + 1; open.lastSeen = t;
      let sent = false;
      let mates = [];
      if (!delivered(open) && due(st, open, t)) {
        const list = await st.list();
        mates = kind === 'needs_you' ? waitingNeeds(st, list, t).filter((i) => i.key !== open.key) : [];
        sent = mates.length ? await deliverNeeds(st, tg, [open, ...mates], list, t, r) : await deliver(st, tg, board, open, list, t, r);
      }
      for (const m of mates) if (m.msg) await st.save(m);
      await st.save(open);
      return { status: sent || delivered(open) || due(st, open, t) ? 'repeat' : 'held', inc: open };
    }
    const list = await st.list();
    let sent = false, err;
    const now0 = due(st, inc, t);
    // a Needs you due now takes every other one already due and unsent with it: one message
    const others = kind === 'needs_you' && now0 ? waitingNeeds(st, list, t).filter((i) => i.key !== inc.key) : [];
    if (now0) try { sent = others.length ? await deliverNeeds(st, tg, [inc, ...others], list, t, r) : await deliver(st, tg, board, inc, list, t, r); } catch (e) { err = e; }
    for (const o2 of others) if (o2.msg) await st.save(o2);
    await st.save(inc);
    if (err) throw err;
    return { status: sent ? 'sent' : !now0 ? 'held' : kind === 'ops' && !board ? 'recorded' : kind === 'ops' || tg.ready ? 'capped' : 'queued', inc };
  });
}

/** 🎉 one line; recorded (where the store keeps news) for the evening summary. One key goes out once. */
async function goodNews(st, tg, o, t) {
  if (!o.text) throw new Error('good_news needs --text: one line, what people can use now');
  // only a store that keeps news (a host's file) can remember a key or hold a line for the summary
  if (!st.news && (o.key || o.summaryOnly)) throw new Error(`good_news: ${st.name} keeps no news, so --key and --summary-only need a file store (send it from the host, or drop them)`);
  const inc = { key: o.key || `good/${t}`, kind: 'good_news', topic: 'good', text: one(o.text), opened: t, closed: t, open: false, msg: null };
  inc.message = TEMPLATES.good_news(inc); mustBePlain('good_news', inc.message);
  return st.locked(async () => {
    if (o.key && (await st.list()).some((i) => i.kind === 'good_news' && i.key === o.key)) return { status: 'repeat', inc };
    if (!o.summaryOnly) { if (!tg.ready) throw new Error('good_news: no bot token or chat id here'); inc.msg = await tg.send('good', inc.message, { t }); inc.sentAt = t; }
    if (st.news) await st.save(inc);
    return { status: o.summaryOnly ? 'kept for the summary' : 'sent', inc };
  });
}

/** ☀️ The evening summary, or null on a day with nothing to say (nothing went live, nothing in progress, nothing for him). */
export async function summaryText(stores, { progress = [], board = opsBoard() } = {}, t = now()) {
  const day = dayOf(t), live = [], needs = [];
  for (const st of stores) for (const i of await st.list()) {
    if (i.kind === 'good_news' && dayOf(i.opened) === day) live.push(i.text);
    if (i.kind === 'needs_you' && i.open && i.msg) needs.push(i.step);
  }
  const lines = progress.map(one).filter(Boolean);
  if (!live.length && !lines.length && !needs.length) return null;
  const date = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: rules().tz }).format(new Date(t));
  let url = null;
  if (board) try { url = await board.url(); } catch (e) { console.error(`notify: the Ops board link: ${e.message}`); }
  const text = TEMPLATES.summary({ date, live, progress: lines, needs, board: url });
  mustBePlain('summary', text);
  return text;
}

/** Post the evening summary once a day (the first store that keeps news remembers it was sent). */
export async function summary(stores, tg, o = {}) {
  const t = now(), key = `summary/${dayOf(t)}`;
  const keep = stores.find((s) => s.news);
  if (!keep) throw new Error('summary: none of the stores keeps news (a file store), so it could neither list good news nor send only once a day');
  // checked and recorded under the store's lock: two runs at once still send one summary
  return keep.locked(async () => {
    if ((await keep.list()).some((i) => i.key === key)) return { status: 'already sent today' };
    const text = await summaryText(stores, o, t);
    if (!text) return { status: 'nothing to say: no summary today' };
    if (o.dryRun) return { status: 'dry run', text };
    await tg.send('summary', text, { t });
    await keep.save({ key, kind: 'summary', opened: t, closed: t, open: false });
    return { status: 'sent', text };
  });
}

/** One line on the Ops board's log (a comment, no row): what a host did by itself, a maintenance notice. */
export async function note(board, text, link) {
  if (!board) throw new Error('ALERTS_OPS_BOARD is not set (github:<owner/name>): a note has nowhere to go');
  if (!one(text)) throw new Error('note needs --text');
  await board.note(`📝 ${one(text)}${link ? `\n${link}` : ''}`);
}

/** The owner's group keeps three topics (K037 E): close the others, their history stays. Never closes
 * Needs you, Good news or Summary; a topic already closed (or gone) is no error. */
export const KEEP_TOPICS = ['needs', 'good', 'summary'];
export async function retire(tg, keys) {
  const ids = await tg.topics(), out = [];
  for (const k of keys) {
    if (KEEP_TOPICS.includes(k)) throw new Error(`"${k}" is one of the three topics the owner keeps`);
    if (!ids[k]) { out.push(`no topic "${k}" in this group`); continue; }
    try { await tg.call('closeForumTopic', { chat_id: tg.chat, message_thread_id: ids[k] }); out.push(`closed "${TOPICS[k]?.name || k}"`); }
    catch (e) { if (/TOPIC_CLOSED|TOPIC_NOT_MODIFIED/.test(e.message)) out.push(`"${TOPICS[k]?.name || k}" was already closed`); else throw e; }
  }
  return out;
}

/** Escalate, remind and send what waits; returns what it did, one line each. */
export async function tick(st, tg, board = boardOrNull()) {
  const r = rules(), t = now(), quiet = isQuiet(t, r), did = [];
  await st.locked(async () => {
    const list = await st.list();
    // a kind is never escalated or reminded ("Needs you" is already his; the summary lists what waits on him):
    // the tick sends what was held or capped and retries the Ops board
    const batch = waitingNeeds(st, list, t);
    if (batch.length > 1 && await deliverNeeds(st, tg, batch, list, t, r)) for (const inc of batch) { await st.save(inc); did.push(`sent ${inc.key}${inc.batch ? ` (one message for ${inc.batch.length})` : ''}`); }
    for (const inc of list.filter((i) => i.kind && ['needs_you', 'outage', 'ops'].includes(i.kind))) {
      let changed = false;
      if (inc.open && !delivered(inc) && due(st, inc, t)) { if (await deliver(st, tg, board, inc, list, t, r)) { changed = true; did.push(`sent ${inc.key}`); } }
      // a held row waits for its hold like a message would (a flap never reaches the board); a closed one syncs its ✅
      else if ((!inc.open || due(st, inc, t)) && await boardSync(board, inc, t)) { changed = true; did.push(`board ${inc.key}`); }
      if (changed) await st.save(inc);
    }
    for (const inc of list.filter((i) => i.open && !i.kind)) {
      let changed = false;
      if (!inc.msg && due(st, inc, t)) { if (await sendProblem(tg, inc, list, t, r)) { changed = true; did.push(`sent ${inc.key}`); } }
      if (inc.msg && (hushed(inc, t) || inc.maxSends)) { /* acknowledged or muted in the control panel; a capped problem's repeats are its sender's */ }
      else if (inc.msg && inc.topic !== 'needs' && !inc.escalated && t - inc.opened >= r.escalateAfter && !quiet && !capped(list, { topic: 'needs' }, t, r)) {
        // its own topic first: a closed one (K039) moves the problem to the Ops board and nothing reaches Needs you
        let moved = false;
        try { await tg.send(inc.topic, `🟠 STILL OPEN after ${age(t - inc.opened)} · escalated to Needs you`, { reply: inc.msg, t }); }
        catch (e) { if (!topicClosed(e)) throw e; moved = toOps(inc, t); }
        if (moved) { changed = true; did.push(`moved ${inc.key} to the Ops board (its topic is closed)`); }
        else {
          const original = await tg.link(inc.topic, inc.msg);
          const you = youOf(inc).startsWith('Needs you:') ? youOf(inc) : 'Needs you: it has not cleared in 3 hours; pass this message to its project\'s coordinator';
          inc.escalated = t; inc.remindedAt = t; changed = true; // recorded before the second send: a failure there never repeats the first
          try { inc.escMsg = await tg.send('needs', `⏰ STILL OPEN after ${age(t - inc.opened)}, nobody resolved it · ${one(inc.text)}${inc.link ? `\n${inc.link}` : ''}\n${original}\nYou: ${you}`, { t }); }
          catch (e) { await st.save(inc); throw e; }
          did.push(`escalated ${inc.key}`);
        }
      } else if (inc.msg && !quiet && t - (inc.remindedAt || inc.opened) >= r.remindEvery) {
        try { await tg.send(inc.topic, `🟠 STILL OPEN after ${age(t - inc.opened)} · ${one(inc.text)}`, { reply: inc.msg, t }); inc.remindedAt = t; did.push(`reminded ${inc.key}`); }
        catch (e) { if (!topicClosed(e)) throw e; toOps(inc, t); did.push(`moved ${inc.key} to the Ops board (its topic is closed)`); }
        changed = true;
      }
      if (inc.kind === 'ops') await boardSync(board, inc, t); // moved this round: its row goes up now
      if (changed) await st.save(inc);
    }
  });
  return did;
}

/** The daily digest across stores: what opened, what resolved, what is still open. */
export async function digestText(stores, t = now()) {
  const day = 24 * HOUR, lines = [];
  let opened = 0, resolved = 0, open = 0;
  for (const st of stores) {
    for (const i of await st.list()) {
      if (i.kind === 'good_news' || i.kind === 'summary') continue; // the evening summary's, not a problem
      const where = i.url || i.link || '';
      if (i.open) { open++; lines.push(`🟠 open ${age(t - i.opened)} · ${one(i.text)}${i.escalated ? ' (escalated)' : ''}${i.maxSends && i.msg ? ` (alerted ${i.sends || 1} of ${i.maxSends})` : ''} ${where}`.trim()); }
      else if (t - i.closed < day) { resolved++; lines.push(`✅ resolved after ${age(i.closed - i.opened)} · ${one(i.text)}`); }
      if (t - i.opened < day) opened++;
    }
  }
  const date = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: rules().tz }).format(new Date(t));
  const head = `🗓 Daily · ${date} · ${open ? `${open} still open` : 'nothing open'}, ${opened} new and ${resolved} resolved in the last 24 h`;
  return [head, ...lines].join('\n');
}

export async function setup(tg) {
  const me = await tg.call('getMe', {});
  const chat = await tg.call('getChat', { chat_id: tg.chat });
  const out = [`bot @${me.username}`, `group "${chat.title}"`];
  if (chat.type !== 'supergroup' || !chat.is_forum) throw new Error(`"${chat.title}" has Topics off: turn on Topics in the group settings`);
  const member = await tg.call('getChatMember', { chat_id: tg.chat, user_id: me.id });
  const missing = ['can_manage_topics', 'can_pin_messages'].filter((p) => !member[p]);
  if (member.status !== 'administrator' || missing.length) throw new Error(`@${me.username} must be an admin with ${missing.join(' and ') || 'Manage topics and Pin messages'}`);
  // only the config stays pinned (owner, 2026-10-06): senders read the chat's pinned message (the newest
  // pinned one by sending date), so a pin of a later message hides the config; unpin those, then read it
  let top = chat.pinned_message;
  for (let k = 0; top && !String(top.text || '').startsWith(CONFIG_MARK); k++) {
    if (k === 20) throw new Error('20 messages pinned over the config: unpin them in the group, then run setup again');
    await tg.call('unpinChatMessage', { chat_id: tg.chat, message_id: top.message_id });
    out.push(`unpinned message ${top.message_id}`);
    top = (await tg.call('getChat', { chat_id: tg.chat })).pinned_message;
  }
  const pinned = top?.text || '';
  const topics = pinned.startsWith(CONFIG_MARK) ? JSON.parse(pinned.slice(pinned.indexOf('{'))).topics : {};
  let created = 0;
  for (const [key, { name, color }] of Object.entries(TOPICS)) {
    if (topics[key]) continue;
    topics[key] = (await tg.call('createForumTopic', { chat_id: tg.chat, name, icon_color: color })).message_thread_id;
    created++; out.push(`created topic "${name}"`);
  }
  if (created || !pinned.startsWith(CONFIG_MARK)) {
    const m = await tg.call('sendMessage', { chat_id: tg.chat, disable_notification: true, text: `${CONFIG_MARK} (every sender reads this; keep it the newest pinned message)\n${JSON.stringify({ v: 1, topics })}` });
    await tg.call('pinChatMessage', { chat_id: tg.chat, message_id: m.message_id, disable_notification: true });
    out.push('pinned the config');
  }
  // nothing is pinned inside a topic either: the config lives in General, problems never stay pinned
  for (const id of Object.values(topics)) await tg.call('unpinAllForumTopicMessages', { chat_id: tg.chat, message_thread_id: id });
  out.push(`topics ${JSON.stringify(topics)} (no pins inside them)`);
  return out;
}

// --- command line -----------------------------------------------------------------------------------
async function main(argv) {
  const [cmd] = argv;
  const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const flag = (n) => argv.includes(n);
  const optAll = (n) => argv.flatMap((a, i) => (a === n && i + 1 < argv.length ? [argv[i + 1]] : []));
  const say = (s) => console.log(`notify: ${s}`);
  const tg = cmd === 'find' ? telegram({ chat: 'none' }) : telegram();
  const storesOf = () => (opt('--stores') || env('ALERTS_STORE') || '').split(',').filter(Boolean).map((s) => store(s.trim()));
  switch (cmd) {
    case 'setup': for (const l of await setup(tg)) say(l); break;
    case 'problem': {
      const r = await problem(store(), tg, { key: opt('--key'), topic: opt('--topic'), text: opt('--text'), link: opt('--link'), title: opt('--title'), action: flag('--action'), outage: flag('--outage'), you: opt('--you'), maxSends: opt('--max-sends') });
      say(`${r.status} ${r.inc.key}${r.inc.url ? ` (${r.inc.url})` : ''}`);
      if (r.status === 'queued' && env('ALERTS_REQUIRE_SEND') === '1') { console.error('notify: no bot token or chat id here, so the problem was recorded but not sent'); process.exit(2); }
      break;
    }
    case 'needs_you': case 'outage': case 'good_news': case 'ops': {
      const r = await raise(store(), tg, { kind: cmd, key: opt('--key'), what: opt('--what'), step: opt('--step'), where: opt('--where'), when: opt('--when'), minutes: opt('--minutes'), link: opt('--link'), system: opt('--system'), who: opt('--who'), text: opt('--text'), summaryOnly: flag('--summary-only') });
      say(`${cmd} ${r.status} ${r.inc.key}`);
      if (r.status === 'queued' && env('ALERTS_REQUIRE_SEND') === '1') { console.error('notify: no bot token or chat id here, so it was recorded but not sent'); process.exit(2); }
      break;
    }
    case 'summary': {
      const r = await summary(storesOf(), tg, { progress: optAll('--progress'), dryRun: flag('--dry-run') });
      say(`summary: ${r.status}`); if (r.text && flag('--dry-run')) console.log(r.text);
      break;
    }
    case 'board': {
      const b = opsBoard(); if (!b) throw new Error('ALERTS_OPS_BOARD is not set (github:<owner/name>)');
      // --open: open it if there is none and pin it (the bot or App does this once, before any host writes to it)
      say(`Ops board: ${flag('--open') ? `${await b.pin()} (open and pinned)` : await b.url(true)}`);
      break;
    }
    case 'resolve': { const r = await resolveKey(store(), tg, { key: opt('--key'), text: opt('--text'), quiet: flag('--quiet') }); say(`${r.status} ${opt('--key')}`); break; }
    case 'tick': { for (const st of storesOf()) for (const l of await tick(st, tg)) say(`${st.name}: ${l}`); break; }
    case 'digest': { // retired (K039): technical, so it is no longer posted; the evening summary and the Ops board replace it
      const text = await digestText(storesOf());
      if (flag('--dry-run')) console.log(text);
      say('the daily digest is retired (K039): nothing posted; the evening summary and the Ops board replace it');
      break;
    }
    case 'note': { await note(opsBoard(), opt('--text'), opt('--link')); say('noted on the Ops board'); break; }
    case 'retire': { for (const l of await retire(tg, (opt('--topics') || '').split(',').map((x) => x.trim()).filter(Boolean))) say(l); break; }
    case 'send': { if (!opt('--topic') || !opt('--text')) throw new Error('--topic and --text are required'); await tg.send(opt('--topic'), opt('--text')); say(`sent to ${opt('--topic')}`); break; }
    case 'test': {
      const mem = { incidents: {}, name: 'memory', async locked(f) { return f(); }, async list() { return Object.values(this.incidents); }, async get(k) { return this.incidents[k]?.open ? this.incidents[k] : null; }, async save(i) { this.incidents[i.key] = i; }, async note() {}, async close(i) { this.incidents[i.key] = i; } };
      // a silent message in "Summary" in the owner's format, then edited to ✅ (K039: no technical test text)
      const topic = opt('--topic') || 'summary';
      const msg = await tg.send(topic, '🔔 Test: the alert bot reaches this group\nWho: Platform\nDo: nothing');
      await tg.edit(topic, msg, '✅ Test: the alert bot reaches this group\nDo: nothing');
      say(`test message ${msg} sent and edited to ✅: ${await tg.link(topic, msg)}`);
      break;
    }
    case 'find': {
      // reads pending updates without confirming them, so nothing is consumed
      const me = await tg.call('getMe', {});
      say(`bot @${me.username}`);
      const ups = await tg.call('getUpdates', { timeout: 0, allowed_updates: ['message', 'my_chat_member'] });
      const chats = new Map();
      for (const u of ups) { const c = u.message?.chat || u.my_chat_member?.chat; if (c && c.type !== 'private') chats.set(c.id, c); }
      if (!chats.size) say('no group in the bot\'s recent updates: add the bot to the group, then post any message there');
      for (const c of chats.values()) say(`group "${c.title}" id ${c.id}${c.is_forum ? ' (Topics on)' : ' (Topics off)'}`);
      break;
    }
    default: throw new Error('usage: notify.mjs needs_you|outage|good_news|ops|summary|board|note|resolve|tick|setup|retire|problem|digest|send|test|find (see the header of this file)');
  }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch((e) => { console.error(`notify: ${e.message}`); process.exit(1); });
}
