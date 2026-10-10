#!/usr/bin/env node
// notify — the owner's one alert standard (O10, K010): one bot, one Telegram group with topics,
// every PROBLEM closed by a RESOLVED (or STILL OPEN) reply. Every sender runs this tool. No dependencies.
//
//   node .harness/tools/notify.mjs setup        check the group, create the missing topics, pin the config
//                                               (unpinning anything pinned after it: only the config stays)
//   node .harness/tools/notify.mjs problem --key <k> --topic <t> --text <t> [--link <url>] [--title <t>]
//        [--action] [--outage] [--you <line>]   open a problem (a repeat of an open key sends nothing)
//   node .harness/tools/notify.mjs resolve --key <k> [--text <t>]
//                                               reply RESOLVED to the problem's message and close it
//   node .harness/tools/notify.mjs tick [--stores <spec,…>]
//                                               escalate, remind STILL OPEN once a day, send queued problems
//   node .harness/tools/notify.mjs digest [--stores <spec,…>]
//                                               post the one daily digest in "Daily"
//   node .harness/tools/notify.mjs send --topic <t> --text <t>     one plain message (silent unless "needs")
//   node .harness/tools/notify.mjs test         a PROBLEM in "Kit & Hands" and its RESOLVED reply (a proof)
//   node .harness/tools/notify.mjs find         the bot's name and the groups it was added to, with their ids
//
// The rules (.harness/alerts.md):
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
  erp: { name: 'ERP', color: 0x6FB9F0 },
  website: { name: 'Website', color: 0x8EEE98 },
  kit: { name: 'Kit & Hands', color: 0xCB86DB },
  ops: { name: 'Laptop & VPS', color: 0xFFD67E },
  daily: { name: 'Daily', color: 0xFB6F5F },
};
export const CONFIG_MARK = 'harness-alerts config';
const HOUR = 3600e3;
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
      const ids = await tg.topics();
      const flat = !Object.keys(ids).length;
      if (!flat && !(topic in ids)) throw new Error(`unknown topic "${topic}" (known: ${Object.keys(ids).join(', ')})`);
      const m = await call('sendMessage', {
        chat_id: chat, ...(flat ? { text: `[${TOPICS[topic]?.name || topic}] ${text}` } : { message_thread_id: ids[topic], text }), link_preview_options: { is_disabled: true },
        disable_notification: !loud(topic, outage, t),
        ...(reply ? { reply_parameters: { message_id: reply, allow_sending_without_reply: true } } : {}),
      });
      return m.message_id;
    },
    async link(topic, msg) { const ids = await tg.topics(); return ids[topic] ? `https://t.me/c/${String(chat).replace(/^-100/, '')}/${ids[topic]}/${msg}` : `message ${msg} in this chat`; },
  };
  return tg;
}

// --- stores: where open problems live ---------------------------------------------------------------
// An incident: { key, topic, text, title, link, outage, opened, sentAt, msg, escalated, escMsg, remindedAt, count, open, closed }
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

function githubStore(repo) {
  const base = env('GITHUB_API_URL', 'https://api.github.com');
  const gh = async (method, path, data) => {
    const r = await fetch(`${base}${path}`, { method, headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${env('GH_TOKEN') || env('GITHUB_TOKEN')}`, 'x-github-api-version': '2022-11-28', 'content-type': 'application/json' }, body: data ? JSON.stringify(data) : undefined });
    const j = r.status === 204 ? {} : await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`GitHub ${method} ${path}: ${r.status} ${j.message || ''}`.trim());
    return j;
  };
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

async function sendProblem(tg, inc, list, t, r) {
  if (!tg.ready || capped(list, inc, t, r)) return false;
  inc.msg = await tg.send(inc.topic, headline(inc), { outage: inc.outage, t });
  inc.sentAt = t;
  return true;
}

export async function problem(st, tg, o) {
  const r = rules(), t = now();
  if (!o.key || !o.text) throw new Error('--key and --text are required');
  if (o.you && !YOU.test(one(o.you))) throw new Error('--you is "nothing", "<who> is fixing it" or "Needs you: <exact step>"');
  const topic = o.outage || o.action ? 'needs' : o.topic;
  if (!topic) throw new Error('--topic is required (needs, erp, website, kit, ops, or another set up topic)');
  return st.locked(async () => {
    const open = await st.get(o.key);
    if (open) {
      open.count = (open.count || 1) + 1; open.lastSeen = t;
      await st.save(open);
      if (o.link) await st.note(open, `Still failing: ${o.link}`);
      if (!open.msg && tg.ready && due(st, open, t)) { const list = await st.list(); if (await sendProblem(tg, open, list, t, r)) await st.save(open); }
      return { status: open.msg || due(st, open, t) ? 'repeat' : 'held', inc: open };
    }
    const inc = { key: o.key, topic, text: one(o.text), title: o.title, link: o.link, outage: !!o.outage, ...(o.you ? { you: one(o.you) } : {}), opened: t, msg: null, count: 1, open: true };
    const list = await st.list();
    let sent = false, err;
    const now0 = due(st, inc, t);
    if (now0) try { sent = await sendProblem(tg, inc, list, t, r); } catch (e) { err = e; }
    await st.save(inc);
    if (err) throw err;
    return { status: sent ? 'sent' : !now0 ? 'held' : tg.ready ? 'capped' : 'queued', inc };
  });
}

export async function resolveKey(st, tg, o) {
  const t = now();
  return st.locked(async () => {
    const inc = await st.get(o.key);
    if (!inc) return { status: 'none' };
    const text = fixed(inc, t);
    if (inc.msg) {
      await tg.send(inc.topic, text, { reply: inc.msg, t });
      if (inc.escMsg) await tg.send('needs', text, { reply: inc.escMsg, t });
    }
    // a resolved problem never stays pinned (owner, 2026-10-06); a message that was not pinned is no error
    for (const id of [inc.msg, inc.escMsg].filter(Boolean)) await tg.call('unpinChatMessage', { chat_id: tg.chat, message_id: id }).catch(() => {});
    inc.open = false; inc.closed = t; inc.resolution = one(o.text || '');
    await st.close(inc, `RESOLVED after ${age(t - inc.opened)}${o.text ? `: ${one(o.text)}` : '.'}`);
    return { status: inc.msg ? 'resolved' : 'closed-unsent', inc };
  });
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

/** Escalate, remind and send what waits; returns what it did, one line each. */
export async function tick(st, tg) {
  const r = rules(), t = now(), quiet = isQuiet(t, r), did = [];
  await st.locked(async () => {
    const list = await st.list();
    for (const inc of list.filter((i) => i.open)) {
      let changed = false;
      if (!inc.msg && due(st, inc, t)) { if (await sendProblem(tg, inc, list, t, r)) { changed = true; did.push(`sent ${inc.key}`); } }
      if (inc.msg && hushed(inc, t)) { /* acknowledged or muted in the control panel */ }
      else if (inc.msg && inc.topic !== 'needs' && !inc.escalated && t - inc.opened >= r.escalateAfter && !quiet && !capped(list, { topic: 'needs' }, t, r)) {
        const original = await tg.link(inc.topic, inc.msg);
        const you = youOf(inc).startsWith('Needs you:') ? youOf(inc) : 'Needs you: it has not cleared in 3 hours; pass this message to its project\'s coordinator';
        inc.escMsg = await tg.send('needs', `⏰ STILL OPEN after ${age(t - inc.opened)}, nobody resolved it · ${one(inc.text)}${inc.link ? `\n${inc.link}` : ''}\n${original}\nYou: ${you}`, { t });
        await tg.send(inc.topic, `🟠 STILL OPEN after ${age(t - inc.opened)} · escalated to Needs you`, { reply: inc.msg, t });
        inc.escalated = t; inc.remindedAt = t; changed = true; did.push(`escalated ${inc.key}`);
      } else if (inc.msg && !quiet && t - (inc.remindedAt || inc.opened) >= r.remindEvery) {
        await tg.send(inc.topic, `🟠 STILL OPEN after ${age(t - inc.opened)} · ${one(inc.text)}`, { reply: inc.msg, t });
        inc.remindedAt = t; changed = true; did.push(`reminded ${inc.key}`);
      }
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
      const where = i.url || i.link || '';
      if (i.open) { open++; lines.push(`🟠 open ${age(t - i.opened)} · ${one(i.text)}${i.escalated ? ' (escalated)' : ''} ${where}`.trim()); }
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
  const say = (s) => console.log(`notify: ${s}`);
  const tg = cmd === 'find' ? telegram({ chat: 'none' }) : telegram();
  const storesOf = () => (opt('--stores') || env('ALERTS_STORE') || '').split(',').filter(Boolean).map((s) => store(s.trim()));
  switch (cmd) {
    case 'setup': for (const l of await setup(tg)) say(l); break;
    case 'problem': {
      const r = await problem(store(), tg, { key: opt('--key'), topic: opt('--topic'), text: opt('--text'), link: opt('--link'), title: opt('--title'), action: flag('--action'), outage: flag('--outage'), you: opt('--you') });
      say(`${r.status} ${r.inc.key}${r.inc.url ? ` (${r.inc.url})` : ''}`);
      if (r.status === 'queued' && env('ALERTS_REQUIRE_SEND') === '1') { console.error('notify: no bot token or chat id here, so the problem was recorded but not sent'); process.exit(2); }
      break;
    }
    case 'resolve': { const r = await resolveKey(store(), tg, { key: opt('--key'), text: opt('--text') }); say(`${r.status} ${opt('--key')}`); break; }
    case 'tick': { for (const st of storesOf()) for (const l of await tick(st, tg)) say(`${st.name}: ${l}`); break; }
    case 'digest': {
      const text = await digestText(storesOf());
      if (flag('--dry-run')) console.log(text);
      else if (!Object.keys(await tg.topics()).length) say('no alerts group set up yet (no pinned config): digest not posted');
      else { await tg.send('daily', text); say('digest posted'); }
      break;
    }
    case 'send': { if (!opt('--topic') || !opt('--text')) throw new Error('--topic and --text are required'); await tg.send(opt('--topic'), opt('--text')); say(`sent to ${opt('--topic')}`); break; }
    case 'test': {
      const mem = { incidents: {}, name: 'memory', async locked(f) { return f(); }, async list() { return Object.values(this.incidents); }, async get(k) { return this.incidents[k]?.open ? this.incidents[k] : null; }, async save(i) { this.incidents[i.key] = i; }, async note() {}, async close(i) { this.incidents[i.key] = i; } };
      const key = `test/${now()}`;
      const p = await problem(mem, tg, { key, topic: opt('--topic') || 'kit', text: 'Test problem from notify.mjs test: the alert standard works end to end' });
      if (p.status !== 'sent') throw new Error(`the test problem was ${p.status}, not sent`);
      await resolveKey(mem, tg, { key, text: 'Test resolved: this RESOLVED is a reply to the problem above' });
      say(`PROBLEM ${p.inc.msg} sent and RESOLVED as a reply: ${await tg.link(p.inc.topic, p.inc.msg)}`);
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
    default: throw new Error('usage: notify.mjs setup|problem|resolve|tick|digest|send|test|find (see the header of this file)');
  }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch((e) => { console.error(`notify: ${e.message}`); process.exit(1); });
}
