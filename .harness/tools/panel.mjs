#!/usr/bin/env node
// panel — the owner's control panel (K025): problems with a fixed set of buttons, /status, and A/B
// decisions answered with a tap, kept in a core that knows nothing about the channel showing it.
// No dependencies.
//
//   node .harness/tools/panel.mjs bind-code --dir <d>      print a one-time code (valid 1 h); the first
//                                                          account to send "/bind <code>" (or "/start
//                                                          <code>", what a t.me/<bot>?start=<code> link
//                                                          sends) in a private chat becomes its owner
//   node .harness/tools/panel.mjs status --dir <d>         print /status as the owner would see it
//   node .harness/tools/panel.mjs serve --dir <d> [--actions <file>] [--once]
//                                                          read presses from the channel and answer them
//        CONTROL_CHANNEL=file (default) or telegram (ALERTS_BOT_TOKEN, ALERTS_CHAT_ID; the group's chat
//        id must also be in CONTROL_CHATS)
//
// The shape (no lock-in):
// - The core owns all state: problems (open, acknowledged, muted, resolved), decisions (asked, answered),
//   the fixed action list, and an append-only log of every action. State is `<dir>/state.json`, the log
//   `<dir>/log.jsonl`, both plain files. The service is the one writer of both; `bind-code` writes only
//   `<dir>/bind-code`, which the service reads when someone sends /bind and deletes once used.
// - An adapter only shows a view ({ text, buttons: [{ id, label }], replyTo }) and turns a press or a
//   message back into an event ({ kind: 'press' | 'text', account, chat, private, button | text }). It
//   keeps nothing the core needs; where it showed a view is noted in the core per channel, so switching
//   channel (CONTROL_CHANNEL) mid-run loses no history.
// - Button ids are `<op>:<view>` (at most 64 bytes, Telegram's limit): a press can only name a view and
//   one of the ops below. It never carries a command.
//     i details · a acknowledge · m mute 24 h · p pause the job · u resume it · r retry it · d<n> option n
// - Only the owner's account bound on that channel counts (one per channel: a Telegram account is not
//   a Discord one), and only in a private chat or a chat in `chats`; anything else is refused and
//   logged. An owner bound before 0.26.0 (one for every channel) is kept for the first channel he uses.
// - A decision's answer goes to the host's `onAnswer({ id, project, issue, option, by, at, channel })`
//   (the kit's ask.mjs writes it on the card it was asked on); one it refuses is not kept.
// - Pause, resume and retry exist only for an alert the action list names ({ id, alerts: [key or
//   "prefix*"], job, retry }); the host's `run({ op, action, problem })` does them.

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { telegram } from './notify.mjs';

export const MUTE_HOURS = 24;
const HOUR = 3600e3;
export const TOPIC_NAMES = { kit: 'Kit & Hands', erp: 'ERP', website: 'Website', ops: 'Laptop & VPS', needs: 'Needs you' };
const LABEL = { i: 'Details', a: 'Acknowledge', m: 'Mute 24h', p: 'Pause automation', u: 'Resume', r: 'Retry' };
const one = (s) => String(s ?? '').replace(/\s*\n\s*/g, ' ').trim();

// --- the core -------------------------------------------------------------------------------------
export function openCore({ dir, actions = [], chats = [], now = () => Date.now(), run = async () => ({ ok: false, text: 'no runner on this host' }), statusExtra = async () => [], onChange = async () => {}, onAnswer = async () => {} }) {
  mkdirSync(dir, { recursive: true });
  const statePath = join(dir, 'state.json');
  const logPath = join(dir, 'log.jsonl');
  const st = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8'))
    : { owners: {}, seq: 0, views: {}, problems: {}, decisions: {} };
  if (!st.owners) { st.owners = st.owner ? { '*': String(st.owner) } : {}; delete st.owner; } // before 0.26.0: one owner, no channel
  const save = () => { writeFileSync(`${statePath}.tmp`, `${JSON.stringify(st, null, 2)}\n`); renameSync(`${statePath}.tmp`, statePath); };
  const log = (entry) => appendFileSync(logPath, `${JSON.stringify({ at: new Date(now()).toISOString(), ...entry })}\n`);
  const view = (about, text, buttons = [], replyTo = null, topic = null) => {
    const id = `v${++st.seq}`;
    const p = about.startsWith('p:') && st.problems[about.slice(2)];
    st.views[id] = { about, shown: {}, ...(p ? { opened: p.opened } : {}) };
    return { id, text, buttons: buttons.map(([op, label]) => ({ id: `${op}:${id}`, label: label || LABEL[op] })), replyTo, topic };
  };
  // a decision's message: its question, options and card link, one button per option (also re-shown by /status)
  const decisionView = (d) => {
    const lines = d.options.map((o, n) => `${String.fromCharCode(65 + n)}. ${o}${n === d.recommended ? ' (recommended)' : ''}`);
    if (/^https:\/\/\S+$/.test(String(d.issue || ''))) lines.push(String(d.issue));
    return view(`d:${d.id}`, `DECISION · ${TOPIC_NAMES[d.project] || d.project}\n${d.question}\n${lines.join('\n')}`,
      d.options.map((_, n) => [`d${n}`, String.fromCharCode(65 + n)]), null, 'needs');
  };
  const actionFor = (key) => actions.find((a) => (a.alerts || []).some((p) => (p.endsWith('*') ? key.startsWith(p.slice(0, -1)) : key === p)));
  const problemButtons = (p) => {
    const a = actionFor(p.key);
    return [['i'], ['a'], ['m'], ...(a ? [p.paused ? ['u'] : ['p']] : []), ...(a?.retry ? [['r']] : [])];
  };
  const codePath = join(dir, 'bind-code');
  const pendingCode = () => {
    if (!existsSync(codePath)) return null;
    try { const c = JSON.parse(readFileSync(codePath, 'utf8')); return c.until > now() ? c.code : null; } catch { return null; }
  };
  const muted = (p) => p.mutedUntil && p.mutedUntil > now();
  const firstView = (about) => Object.keys(st.views).find((v) => st.views[v].about === about) || null;

  const core = {
    /** A problem opened or repeated. Returns the view to show, or null for a repeat. With `shownAt`
     * ({ <channel>: ref }: where the sender's own alert message is), the view is only the buttons, as a
     * reply under that message. */
    problem({ key, topic = 'ops', title, text, link, shownAt = null }) {
      const p = st.problems[key];
      if (p && p.state !== 'resolved') { p.repeats++; save(); log({ who: 'sender', what: 'repeat', target: key }); return null; }
      st.problems[key] = { key, topic, title: one(title || text).slice(0, 80), text: String(text ?? ''), link: link || null, opened: now(), repeats: 0, state: 'open', mutedUntil: null, paused: false };
      let anchor = null;
      if (shownAt) { anchor = view(`alert:${key}`, '').id; st.views[anchor].shown = { ...shownAt }; }
      const v = view(`p:${key}`, anchor ? `Actions · ${one(title || text).slice(0, 80)}` : `PROBLEM · ${TOPIC_NAMES[topic] || topic}\n${one(title || text)}`, problemButtons(st.problems[key]), anchor, topic);
      st.problems[key].view = v.id;
      save(); log({ who: 'sender', what: 'open', target: key });
      return v;
    },
    /** A problem resolved: the RESOLVED reply under its message. */
    resolve(key, text = '') {
      const p = st.problems[key];
      if (!p || p.state === 'resolved') return null;
      p.state = 'resolved'; p.resolved = now(); p.mutedUntil = null;
      const min = Math.max(1, Math.round((now() - p.opened) / 60e3));
      const v = view(`r:${key}`, `RESOLVED · ${p.title}${text ? `\n${one(text)}` : ''}\n✅ Fixed after ${min} min`, [], p.view, p.topic);
      save(); log({ who: 'sender', what: 'resolve', target: key });
      return v;
    },
    /** A decision for the owner: 2-4 options, one recommended. */
    ask({ id, project = 'kit', question, options, recommended = 0, issue = null }) {
      if (!id || !question || !Array.isArray(options) || options.length < 2 || options.length > 4) throw new Error('ask needs an id, a question and 2-4 options');
      if (st.decisions[id]) return null;
      st.decisions[id] = { id, project, question: one(question), options: options.map(one), recommended, issue, asked: now(), answer: null };
      const v = decisionView(st.decisions[id]);
      st.decisions[id].view = v.id;
      save(); log({ who: 'sender', what: 'ask', target: id });
      return v;
    },
    /** Muted problems whose 24 h ended are shown again. */
    tick() {
      const out = [];
      for (const p of Object.values(st.problems)) {
        if (p.state !== 'muted' || p.mutedUntil > now()) continue;
        p.state = 'open'; p.mutedUntil = null;
        out.push(view(`p:${p.key}`, `STILL OPEN · ${TOPIC_NAMES[p.topic] || p.topic}\n${p.title}\n(mute ended)`, problemButtons(p), p.view, p.topic));
        log({ who: 'panel', what: 'unmute', target: p.key });
      }
      if (out.length) save();
      return out;
    },
    async statusText() {
      const lines = [];
      for (const [topic, name] of Object.entries(TOPIC_NAMES)) {
        const ps = Object.values(st.problems).filter((p) => p.topic === topic && p.state !== 'resolved');
        const ds = Object.values(st.decisions).filter((d) => d.project === topic && d.answer === null);
        if (!ps.length && !ds.length) continue;
        lines.push(`${name}:`);
        for (const p of ps) lines.push(`  problem: ${p.title}${p.state === 'acknowledged' ? ' (acknowledged)' : muted(p) ? ' (muted)' : ''}${p.paused ? ' (job paused)' : ''}`);
        for (const d of ds) lines.push(`  decision waiting: ${d.question}`);
      }
      const extra = await statusExtra();
      return ['STATUS', ...(lines.length ? lines : ['nothing open, no decision waiting']), ...extra].join('\n');
    },
    /** Make a one-time binding code (the first account to send it becomes the owner). */
    bindCode() { const code = randomBytes(4).toString('hex'); writeFileSync(`${codePath}.tmp`, JSON.stringify({ code, until: now() + HOUR }), { mode: 0o600 }); renameSync(`${codePath}.tmp`, codePath); return code; },
    /** The owner's account on a channel, or null. */
    ownerOn: (channel) => st.owners[channel] ?? null,
    /** The host binds the owner it already knows on a channel (for example the private chat that answered
     * an earlier one-time code on this host); only while that channel has none. */
    bindOwner(account, how, channel) {
      if (!channel || st.owners[channel] || !/^\d{1,20}$/.test(String(account))) return false;
      st.owners[channel] = String(account); delete st.owners['*']; save(); log({ who: 'host', channel, what: 'bind', target: String(account), result: one(how) });
      return true;
    },
    /** Where an adapter showed a view (its own note; the core never reads it back for itself). */
    note(viewId, channel, ref) { if (st.views[viewId]) { st.views[viewId].shown[channel] = ref; save(); } },
    shownOn(viewId, channel) { return st.views[viewId]?.shown[channel] ?? null; },
    /** Handle one event from a channel. Returns the views to show in answer. */
    async handle(ev, channel) {
      const who = String(ev.account);
      const refuse = (why) => { log({ who, channel, what: 'refused', target: ev.button || one(ev.text).replace(/^(\/bind|\/start)\b.*/, '$1').slice(0, 40), result: why }); save(); return []; };
      if (!st.owners[channel] && st.owners['*'] === who) { st.owners[channel] = who; delete st.owners['*']; save(); log({ who, channel, what: 'bind', result: 'the owner bound before 0.26.0, first seen on this channel' }); }
      const code = !st.owners[channel] && ev.kind === 'text' && /^\/(bind|start)\b/.test(one(ev.text)) ? pendingCode() : null;
      if (code && ev.private && (one(ev.text) === `/bind ${code}` || one(ev.text) === `/start ${code}`)) {
        st.owners[channel] = who; rmSync(codePath, { force: true }); save(); log({ who, channel, what: 'bind' });
        return [view('bind', 'This account is now the panel owner on this channel.')];
      }
      if (!st.owners[channel] || who !== st.owners[channel]) return refuse('not the owner');
      if (!ev.private && !chats.map(String).includes(String(ev.chat))) return refuse('not an allowed chat');
      if (ev.kind === 'text') {
        if (/^\/status\b/.test(one(ev.text))) { // the status, then each waiting decision again with its buttons, so none is lost in the scroll
          log({ who, channel, what: 'status' });
          const out = [view('status', await core.statusText()), ...Object.values(st.decisions).filter((d) => d.answer === null).map(decisionView)];
          save(); return out;
        }
        return refuse('unknown command');
      }
      const m = /^(i|a|m|p|u|r|d[0-3]):(v\d+)$/.exec(String(ev.button || ''));
      const about = m && st.views[m[2]]?.about;
      if (!about) return refuse('unknown button');
      const [op, vid] = [m[1], m[2]];
      if (op.startsWith('d')) {
        const d = about.startsWith('d:') && st.decisions[about.slice(2)];
        const n = Number(op.slice(1));
        if (!d || n >= d.options.length) return refuse('unknown button');
        if (d.answer !== null) { log({ who, channel, what: 'answer', target: d.id, result: 'already answered' }); save(); return [view(`d:${d.id}`, `Already answered: ${String.fromCharCode(65 + d.answer.option)}. ${d.options[d.answer.option]}`, [], vid)]; }
        try { await onAnswer({ id: d.id, project: d.project, issue: d.issue, option: n, by: `${channel}:${who}`, at: new Date(now()).toISOString(), channel }); }
        catch (e) { log({ who, channel, what: 'answer', target: d.id, result: `failed: ${one(e.message)}` }); save(); return [view(`d:${d.id}`, `Not recorded: ${one(e.message)}. Press again.`, [], vid)]; }
        d.answer = { option: n, by: who, at: now(), channel };
        save(); log({ who, channel, what: 'answer', target: d.id, result: String.fromCharCode(65 + n) });
        return [view(`d:${d.id}`, `Answered ${String.fromCharCode(65 + n)}: ${d.options[n]}. Sent back to ${TOPIC_NAMES[d.project] || d.project}.`, [], vid)];
      }
      const p = about.startsWith('p:') && st.problems[about.slice(2)];
      if (!p) return refuse('unknown button');
      if (st.views[vid].opened !== undefined && st.views[vid].opened !== p.opened) { log({ who, channel, what: 'press', target: p.key, result: 'old message' }); save(); return [view(`p:${p.key}`, 'This message is about an earlier, resolved problem.', [], vid)]; }
      const reply = (text) => [view(`p:${p.key}`, text, [], vid)];
      if (op === 'i') {
        log({ who, channel, what: 'details', target: p.key }); save();
        return reply(`${p.text}\nOpened ${new Date(p.opened).toISOString().slice(0, 16).replace('T', ' ')} UTC · repeated ${p.repeats} times${p.link ? `\n${p.link}` : ''}`);
      }
      if (p.state === 'resolved') { log({ who, channel, what: LABEL[op].toLowerCase(), target: p.key, result: 'already resolved' }); save(); return reply('Already resolved.'); }
      // the sender's own store learns it too (onChange: { what, key, ack, mutedUntil }, the whole new
      // state, so a mute after an acknowledge lifts the acknowledge), so its escalation and reminders stop; the panel's
      // state holds either way, and a failure to tell the sender is logged with the press
      const tell = async (change) => { try { await onChange(change); return 'ok'; } catch (e) { return `ok; the alert's sender was not told: ${one(e.message)}`; } };
      if (op === 'a') { p.state = 'acknowledged'; save(); log({ who, channel, what: 'acknowledge', target: p.key, result: await tell({ what: 'acknowledge', key: p.key, ack: true, mutedUntil: null }) }); return reply('Acknowledged: no escalation, no reminder; still in /status.'); }
      if (op === 'm') { p.state = 'muted'; p.mutedUntil = now() + MUTE_HOURS * HOUR; save(); log({ who, channel, what: 'mute', target: p.key, result: await tell({ what: 'mute', key: p.key, ack: false, mutedUntil: p.mutedUntil }) }); return reply(`Muted for ${MUTE_HOURS} h.`); }
      const action = actionFor(p.key);
      if (!action || (op === 'r' && !action.retry)) return refuse('no such action for this alert');
      const what = { p: 'pause', u: 'resume', r: 'retry' }[op];
      let res;
      try { res = await run({ op: what, action, problem: { key: p.key, topic: p.topic } }); } catch (e) { res = { ok: false, text: e.message }; }
      if (res.ok && op !== 'r') p.paused = op === 'p';
      save(); log({ who, channel, what, target: p.key, action: action.id, result: res.ok ? 'ok' : `failed: ${one(res.text)}` });
      return [view(`p:${p.key}`, `${LABEL[op]}: ${res.ok ? 'done' : 'failed'}${res.text ? ` · ${one(res.text)}` : ''}`, op === 'p' && res.ok ? [['u']] : [], vid)];
    },
    state: () => JSON.parse(JSON.stringify(st)),
    log: () => (existsSync(logPath) ? readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
  };
  return core;
}

// --- delivery: show views on a channel, note where they went ---------------------------------------
// An answer to an event goes to the chat the event came from (`ev`), unless it replies to a view this
// channel showed; any other view goes to the channel's own place for its topic.
export async function deliver(core, adapter, views, ev = null) {
  for (const v of views) {
    try { core.note(v.id, adapter.name, await adapter.show(v, v.replyTo ? core.shownOn(v.replyTo, adapter.name) : null, ev)); }
    catch (e) { console.error(`panel: could not show ${v.id} on ${adapter.name}: ${e.message}`); } // one failed view never skips the rest
  }
}
/** The service: passes until `stop()`; a failed pass (network, Telegram 4xx/5xx) is logged and retried
 * after `backoff` ms, so the panel never dies on a channel error. Returns the number of failed passes. */
export async function serveLoop(core, adapter, { stop = () => false, pause = 0, backoff = 5000 } = {}) {
  let failed = 0;
  while (!stop()) {
    try { await step(core, adapter); if (pause) await new Promise((ok) => setTimeout(ok, pause)); }
    catch (e) { failed++; console.error(`panel: ${adapter.name} pass failed: ${e.message}`); await new Promise((ok) => setTimeout(ok, backoff)); }
  }
  return failed;
}
/** One pass: read the channel's new events, answer each. Returns the number of events. */
export async function step(core, adapter) {
  const events = await adapter.poll();
  for (const ev of events) await deliver(core, adapter, await core.handle(ev, adapter.name), ev);
  await deliver(core, adapter, core.tick());
  return events.length;
}

// --- the file adapter: the second channel that proves no lock-in ------------------------------------
// Shows each view as one JSON line in <dir>/shown.jsonl (its ref is the line number) and reads events
// as JSON lines from <dir>/events.jsonl, keeping only its read position in <dir>/.read.
export function fileAdapter({ dir }) {
  mkdirSync(dir, { recursive: true });
  const shown = join(dir, 'shown.jsonl'), events = join(dir, 'events.jsonl'), pos = join(dir, '.read');
  const lines = (f) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean) : []);
  return {
    name: 'file',
    async show(v, replyRef) {
      const ref = lines(shown).length + 1;
      appendFileSync(shown, `${JSON.stringify({ ref, text: v.text, buttons: v.buttons, reply: replyRef })}\n`);
      return ref;
    },
    async poll() {
      const all = lines(events), from = existsSync(pos) ? Number(readFileSync(pos, 'utf8')) : 0;
      writeFileSync(pos, String(all.length));
      return all.slice(from).map((l) => JSON.parse(l));
    },
    /** For tests and the host: put an event on this channel. */
    push(ev) { appendFileSync(events, `${JSON.stringify(ev)}\n`); },
    shown: () => lines(shown).map((l) => JSON.parse(l)),
  };
}

// --- the Telegram adapter ---------------------------------------------------------------------------
// Shows a view as a message with one inline button per view button (callback data = the button id),
// in the group (ALERTS_CHAT_ID) under the view's topic, or in the chat an event came from. Reads presses
// and messages by asking Telegram for updates (getUpdates, going out only: no open port). Its only
// note is the next update offset, in <dir>/.offset; a shown view's ref is { chat, msg }.
// One reader per bot: while this runs, `notify.mjs find` must not.
export function telegramAdapter({ dir, tg, wait = 0 }) {
  mkdirSync(dir, { recursive: true });
  const off = join(dir, '.offset');
  const keyboard = (buttons) => {
    const rows = [];
    for (let i = 0; i < buttons.length; i += 3) rows.push(buttons.slice(i, i + 3).map((b) => ({ text: b.label, callback_data: b.id })));
    return rows.length ? { reply_markup: { inline_keyboard: rows } } : {};
  };
  return {
    name: 'telegram',
    async show(v, replyRef, ev) {
      let text = v.text; // Telegram counts UTF-16 units; cut on whole characters, never half a pair
      if (text.length > 4000) { let cut = ''; for (const c of text) { if (cut.length + c.length > 3990) break; cut += c; } text = `${cut}\n…`; }
      const base = { text, link_preview_options: { is_disabled: true }, ...keyboard(v.buttons) };
      let m;
      if (replyRef) m = await tg.call('sendMessage', { ...base, chat_id: replyRef.chat, ...(replyRef.thread ? { message_thread_id: replyRef.thread } : {}), disable_notification: true, reply_parameters: { message_id: replyRef.msg, allow_sending_without_reply: true } });
      else if (ev) m = await tg.call('sendMessage', { ...base, chat_id: ev.chat, ...(ev.thread ? { message_thread_id: ev.thread } : {}), disable_notification: true });
      else {
        const ids = await tg.topics();
        const thread = ids[v.topic || 'ops'] ?? ids.ops;
        m = await tg.call('sendMessage', { ...base, chat_id: tg.chat, ...(thread ? { message_thread_id: thread } : {}), disable_notification: v.topic !== 'needs' });
      }
      return { chat: m.chat?.id ?? (replyRef?.chat ?? ev?.chat ?? tg.chat), msg: m.message_id, thread: m.message_thread_id ?? null };
    },
    async poll() {
      const offset = existsSync(off) ? Number(readFileSync(off, 'utf8')) : 0;
      const ups = await tg.call('getUpdates', { offset, timeout: wait, allowed_updates: ['message', 'callback_query'] });
      const out = [];
      for (const u of ups) {
        writeFileSync(off, String(u.update_id + 1));
        if (u.callback_query) {
          const q = u.callback_query, chat = q.message?.chat;
          await tg.call('answerCallbackQuery', { callback_query_id: q.id }).catch(() => {});
          if (chat) out.push({ kind: 'press', account: q.from.id, chat: chat.id, private: chat.type === 'private', thread: q.message.message_thread_id ?? null, button: q.data });
        } else if (u.message?.text && u.message.from) {
          const msg = u.message;
          out.push({ kind: 'text', account: msg.from.id, chat: msg.chat.id, private: msg.chat.type === 'private', thread: msg.message_thread_id ?? null, text: msg.text });
        }
      }
      return out;
    },
  };
}

/** The channels this kit ships; CONTROL_CHANNEL picks one. */
export const ADAPTERS = { file: fileAdapter, telegram: telegramAdapter };
export function pickAdapter(name = process.env.CONTROL_CHANNEL || 'file', opts = {}) {
  const make = ADAPTERS[name];
  if (!make) throw new Error(`CONTROL_CHANNEL "${name}" is not a known channel (${Object.keys(ADAPTERS).join(', ')})`);
  return make(opts);
}

// --- command line --------------------------------------------------------------------------------
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [cmd, ...rest] = process.argv.slice(2);
  const arg = (k) => { const i = rest.indexOf(`--${k}`); return i < 0 ? undefined : rest[i + 1]; };
  const dir = arg('dir');
  if (!dir || !['bind-code', 'status', 'serve'].includes(cmd)) { console.error('usage: panel.mjs bind-code|status|serve --dir <d> [--actions <file>] [--once]'); process.exit(2); }
  const actions = arg('actions') ? JSON.parse(readFileSync(arg('actions'), 'utf8')) : [];
  const chats = (process.env.CONTROL_CHATS || '').split(',').filter(Boolean);
  const core = openCore({ dir, actions, chats });
  if (cmd === 'bind-code') console.log(core.bindCode());
  if (cmd === 'status') console.log(await core.statusText());
  if (cmd === 'serve') {
    const name = process.env.CONTROL_CHANNEL || 'file';
    const adapter = pickAdapter(name, { dir: join(dir, `channel-${name}`), tg: name === 'telegram' ? telegram() : undefined, wait: rest.includes('--once') ? 0 : 25 });
    if (rest.includes('--once')) await step(core, adapter);
    else await serveLoop(core, adapter, { pause: name === 'telegram' ? 0 : 2000 });
  }
}
