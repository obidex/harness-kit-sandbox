#!/usr/bin/env node
// usage — where the weekly allowance goes, from the threads' own session records (K072).
//
//   node .harness/tools/usage.mjs next  --from <ISO> [--to <ISO>] [--dir <path>] [--max 8]
//                                   the next list_events calls to make (one JSON line each), then DONE
//   node .harness/tools/usage.mjs table --from <ISO> [--to <ISO>] [--dir <path>] [--project <name>]
//                                   [--role <regex>=<role> …] [--md | --json]
//   node .harness/tools/usage.mjs merge <file.json> … [--from <ISO>] [--to <ISO>] [--md | --json]
//                                   [--points <n> --points-at <ISO> --since <ISO>] [--merged <project>=<n> …]
//
// Where the records come from (no key, no network): a cloud thread reads other threads' records only
// through `list_threads` (hearthbot; `list_thread_sessions` in some sessions) and claude-code-remote's `list_events`, and their results stay in its
// own transcript (`~/.claude/projects/**/*.jsonl`, subagents included) or in the files a long result is
// saved to. This tool reads those back. `next` says which page to fetch next, so a Haiku worker can do
// the paging with no judgment (`usage.md`); `table` turns the pages into the table.
//
// What one wake is: the events between two `result` records of a thread. Its record gives what started
// it (`origin.kind`), its model calls (`num_turns`) and its price per model (`model_usage_since_last_result`,
// costUSD at list price). Within a wake the price of a model is shared out over its calls by weighted
// tokens (input 1, cache read 0.1, cache write 1.25 for 5 minutes or 2 for an hour, output 5): that gives
// each subagent (by type) its part. Warm or cold: the wake's first main call wrote more of its prompt
// to the cache than it read. A wake is "short" when it ended within 4 model calls (A25's waiting share).
//
// Exit 0 = printed; 2 = usage; 3 = no records found.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

export const SHORT_CALLS = 4;
export const CTX_STEPS = [200000, 300000, 384000];
const W = { input: 1, read: 0.1, cw5m: 1.25, cw1h: 2, output: 5 };

// ---------- reading the transcripts ----------

function walk(dir, out = []) {
  let names = [];
  try { names = readdirSync(dir); } catch { return out; }
  for (const n of names) {
    const p = join(dir, n);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, out); else if (n.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === 'string' ? c : c?.text || '')).join('');
  return '';
}

/** The JSON object that starts at the first `start` in `s` (brace matching, strings respected). */
export function jsonAt(s, start) {
  const i = s.indexOf(start);
  if (i < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let j = i; j < s.length; j++) {
    const ch = s[j];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      const text = s.slice(i, j + 1);
      try { return JSON.parse(text); } catch { /* a raw control character inside a string: blank it and try once more */ }
      try { return JSON.parse(text.replace(/[\u0000-\u001f]/g, ' ')); } catch { return null; }
    }
  }
  return null;
}

function resultText(content) {
  const t = textOf(content);
  const m = /^\s*(<[^>]+>\s*)*Error: result /.test(t) ? t.match(/Output has been saved to (\S+?\/tool-results\/\S+?\.txt)/) : null;
  if (m && existsSync(m[1])) { try { return readFileSync(m[1], 'utf8'); } catch { return t; } }
  return t;
}

export const sessionKey = (id) => String(id || '').replace(/^cse_/, 'session_');

/** Reads every list_threads and list_events result in the transcripts under `dirs`.
 *  → { threads: Map(key → {title, created_at, last_activity_at}), pages: Map(key → [{first_id, has_more, events}]) } */
export function readRecords(dirs) {
  const threads = new Map(), pages = new Map();
  for (const file of dirs.flatMap((d) => walk(d))) {
    const uses = new Map();
    let lines; try { lines = readFileSync(file, 'utf8').split('\n'); } catch { continue; }
    for (const line of lines) {
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      const content = o?.message?.content;
      if (!Array.isArray(content)) continue;
      for (const c of content) {
        if (c?.type === 'tool_use' && /list_events$|list_thread(s|_sessions)$/.test(c.name || '')) uses.set(c.id, c);
        if (c?.type !== 'tool_result' || !uses.has(c.tool_use_id)) continue;
        const use = uses.get(c.tool_use_id);
        const text = resultText(c.content);
        if (/list_thread(s|_sessions)$/.test(use.name)) {
          const j = jsonAt(text, '{"sessions"');
          for (const s of j?.sessions || []) threads.set(sessionKey(s.session_id), { title: s.title || '', created_at: s.created_at, last_activity_at: s.last_activity_at || s.created_at, thread_id: s.thread_id });
        } else {
          const j = jsonAt(text, '{"ccr"');
          if (!j?.ccr) continue;
          const key = sessionKey(use.input?.session_id);
          if (!pages.has(key)) pages.set(key, []);
          pages.get(key).push({ first_id: j.ccr.first_id, has_more: !!j.ccr.has_more, filtered: !!use.input?.kinds, events: j.ccr.data || [] });
        }
      }
    }
  }
  return { threads, pages };
}

// ---------- next: the paging plan ----------

/** The calls still needed so each thread active since `from` is read back to `from`. */
export function plan({ threads, pages }, { from, to, max = 8 }) {
  const calls = [];
  for (const [key, t] of threads) {
    if (t.last_activity_at && t.last_activity_at < from) continue;
    if (to && t.created_at && t.created_at > to) continue;
    const ps = (pages.get(key) || []).filter((p) => !p.filtered && p.events.length);
    if (!ps.length) { calls.push({ session_id: key, limit: 100 }); continue; }
    const oldest = ps.reduce((a, p) => (p.events[0].created_at < a.events[0].created_at ? p : a));
    if (!oldest.has_more || oldest.events[0].created_at < from) continue;
    calls.push({ session_id: key, limit: 100, before_id: oldest.first_id });
  }
  return calls.slice(0, max);
}

// ---------- table ----------

const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

function weighted(u = {}) {
  const cc = u.cache_creation || {};
  const h1 = cc.ephemeral_1h_input_tokens ?? 0, m5 = cc.ephemeral_5m_input_tokens ?? Math.max(0, (u.cache_creation_input_tokens || 0) - h1);
  return (u.input_tokens || 0) * W.input + (u.cache_read_input_tokens || 0) * W.read + m5 * W.cw5m + h1 * W.cw1h + (u.output_tokens || 0) * W.output;
}
const ctxOf = (u = {}) => (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
const inner = (e, k) => e[k]?.internal_anthropic_catchall || null;

/** What started a wake, read from the first text that opened it (the record's own origin.kind is a
 *  catch-all: a thread start or a PR event is often filed as a task notice). Null when the first text says nothing. */
export function guessOrigin(texts) {
  for (const t of texts.slice(0, 1)) {
    if (/^\s*<session-context /.test(t)) return 'thread start';
    const wake = t.match(/^\s*<wake reason="([a-z-]+)"/);
    if (wake) return wake[1] === 'spawn' ? 'thread start' : `wake:${wake[1]}`;
    if (/^\s*(Another Claude session sent a message:\s*)?<agent-message /.test(t)) return 'peer';
    if (/^\s*<task-notification>/.test(t)) return 'task-notification';
    if (/^\s*\[auto-continue/.test(t)) return 'auto-continue';
    if (/^\s*<system-note>/.test(t)) return 'wake:project-note';
  }
  return null;
}

function roleOf(title, firstOrigin, rules) {
  for (const [re, role] of rules) if (re.test(title)) return role;
  if (/coordinator/i.test(title)) return 'coordinator';
  if (/schedul|trigger|cron/i.test(firstOrigin || '') || /daily start|scheduled|routine|check-in/i.test(title)) return 'task';
  return 'builder';
}

function briefInput(u) {
  const i = u?.input || {};
  const s = i.command || i.file_path || i.pattern || i.query || i.url || i.description || JSON.stringify(i);
  return `${u?.name || '?'}: ${String(s).replace(/\s+/g, ' ').slice(0, 120)}`;
}

/** One record per wake, plus per-thread facts. */
export function wakes({ threads, pages }, { from, to, project = '', rules = [] }) {
  const out = [], tools = [], compactions = [];
  for (const [key, ps] of pages) {
    const seen = new Set(), evs = [];
    for (const p of ps) for (const e of p.events) {
      const id = e[Object.keys(e).find((k) => k !== 'created_at')]?.uuid || JSON.stringify(e).slice(0, 200);
      if (seen.has(id)) continue; seen.add(id); evs.push(e);
    }
    evs.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
    // the thread's start is in the records only when its oldest page has nothing older
    const full = ps.filter((p) => !p.filtered && p.events?.length);
    const sawStart = full.length > 0 && full.reduce((a, p) => (p.events[0].created_at < a.events[0].created_at ? p : a)).has_more === false;
    const title = threads.get(key)?.title || key;
    const toolSeen = new Set();
    let firstOrigin = null, calls = [], msgSeen = new Set(), uses = new Map(), opened = [], idx = 0;
    const inWin = (t) => t >= from && (!to || t <= to);
    for (const e of evs) {
      const a = inner(e, 'assistant');
      if (a) {
        const m = a.message || {};
        for (const c of m.content || []) if (c.type === 'tool_use') uses.set(c.id, c);
        if (m.id && msgSeen.has(m.id)) continue;
        if (m.id) msgSeen.add(m.id);
        const cw = weighted({ cache_creation_input_tokens: m.usage?.cache_creation_input_tokens, cache_creation: m.usage?.cache_creation });
        calls.push({ model: m.model || '?', role: a.agent_id ? `subagent:${a.subagent_type || 'unnamed'}` : 'main', task: a.agent_id ? String(a.task_description || '').replace(/\d+/g, '#') : '', w: weighted(m.usage), ctx: ctxOf(m.usage), cold: (m.usage?.cache_creation_input_tokens || 0) > (m.usage?.cache_read_input_tokens || 0), extra: cw - (m.usage?.cache_creation_input_tokens || 0) * W.read });
        continue;
      }
      const u = inner(e, 'user');
      if (u && !u.parent_tool_use_id && opened.length < 4) {
        const c = u.message?.content;
        const t = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x) => x?.type === 'text').map((x) => x.text).join('') : '';
        if (t) opened.push(t.slice(0, 4000));
      }
      const note = e.internal_anthropic_catchall;
      if (note?.notification?.content && opened.length < 4) opened.push(String(note.notification.content).slice(0, 4000));
      if (u && inWin(e.created_at)) for (const c of u.message?.content || []) {
        if (c?.type !== 'tool_result') continue;
        if (toolSeen.has(c.tool_use_id)) continue;
        toolSeen.add(c.tool_use_id);
        const items = Array.isArray(c.content) ? c.content : [c.content];
        const images = items.filter((x) => x?.type === 'image').length;
        const size = items.filter((x) => x?.type !== 'image').map((x) => (typeof x === 'string' ? x : x?.text || '')).join('').length;
        tools.push({ project, thread: title, at: e.created_at, size, images, what: briefInput(uses.get(c.tool_use_id)) });
      }
      const s = inner(e, 'system');
      if (s?.compact_result === 'success' && inWin(e.created_at)) compactions.push({ project, thread: title, at: e.created_at });
      const r = inner(e, 'result');
      if (!r) continue;
      let origin = guessOrigin(opened) || r.origin?.kind || 'unknown';
      const here = calls; calls = []; msgSeen = new Set(); opened = [];
      if (!here.length && !Object.values(r.model_usage_since_last_result || {}).some((mu) => Number(mu.costUSD) > 0)) continue; // an empty record is no wake
      const nth = here.some((c) => c.role === 'main') ? idx++ : idx;
      const start = nth === 0 && sawStart;
      if (origin === 'unknown' && start) origin = 'thread start'; // its opening text is not in the records
      if (!firstOrigin) firstOrigin = origin;
      if (!inWin(e.created_at)) continue;
      const since = r.model_usage_since_last_result || {};
      const parts = {}, tasks = {};
      let coldUsd = 0;
      const firstMain = here.find((c) => c.role === 'main');
      for (const [model, mu] of Object.entries(since)) {
        const usd = Number(mu.costUSD || 0);
        const mine = here.filter((c) => c.model === model);
        const tw = mine.reduce((s, c) => s + c.w, 0);
        if (!mine.length || !tw) { parts[`${model}|unseen`] = (parts[`${model}|unseen`] || 0) + usd; continue; }
        for (const c of mine) {
          parts[`${model}|${c.role}`] = (parts[`${model}|${c.role}`] || 0) + (usd * c.w) / tw;
          if (c.task) tasks[c.task] = (tasks[c.task] || 0) + (usd * c.w) / tw;
        }
        if (firstMain?.cold && firstMain.model === model && !start) coldUsd += (usd * Math.max(0, firstMain.extra)) / tw;
      }
      const mainCalls = here.filter((c) => c.role === 'main');
      const ctxCalls = mainCalls.map((c) => ({ ctx: c.ctx, usd: 0, w: c.w }));
      out.push({
        project, thread: title, key, at: e.created_at, origin, calls: Number(r.num_turns || mainCalls.length || 0),
        warmth: mainCalls.length ? (mainCalls[0].cold ? (start ? 'cold (thread start)' : 'cold') : 'warm') : 'n/a',
        usd: Object.values(parts).reduce((s, x) => s + x, 0), parts, tasks, coldUsd,
        ctx: ctxCalls.map((c) => [c.ctx, c.w]),
      });
    }
    const role = roleOf(title, firstOrigin, rules);
    for (const w of out) if (w.key === key) w.role = role;
  }
  return { wakes: out, tools, compactions };
}

const pct = (x, t) => (t ? `${((100 * x) / t).toFixed(1)}%` : '-');
const usdf = (x) => `$${x.toFixed(2)}`;

/** Every figure M1 and M3 ask for, from wake records. */
export function summarize({ wakes: ws, tools = [], compactions = [] }) {
  const total = ws.reduce((s, w) => s + w.usd, 0);
  const by = (fn) => { const m = new Map(); for (const w of ws) for (const [k, v] of fn(w)) m.set(k, (m.get(k) || 0) + v); return [...m].sort((a, b) => b[1] - a[1]); };
  const rows = by((w) => Object.entries(w.parts).map(([k, v]) => { const [model, sub] = k.split('|'); return [`${w.project}|${model}|${sub === 'main' ? w.role : sub}|${w.origin}|${w.warmth}`, v]; }));
  const short = ws.filter((w) => w.calls <= SHORT_CALLS);
  // context at a call: each main call's share of its wake's price, by its weighted tokens
  const ctxUse = []; const ctxAll = [];
  for (const w of ws) {
    const tw = w.ctx.reduce((s, [, x]) => s + x, 0);
    const mainUsd = Object.entries(w.parts).filter(([k]) => k.endsWith('|main')).reduce((s, [, v]) => s + v, 0);
    for (const [c, x] of w.ctx) { ctxAll.push(c); ctxUse.push([c, tw ? (mainUsd * x) / tw : 0]); }
  }
  const mainTotal = ctxUse.reduce((s, [, v]) => s + v, 0);
  const threads = by((w) => [[`${w.project}|${w.thread}`, w.usd]]);
  const wakesOf = new Map(); for (const w of ws) wakesOf.set(`${w.project}|${w.thread}`, (wakesOf.get(`${w.project}|${w.thread}`) || 0) + 1);
  return {
    total, wakes: ws.length, threads: new Set(ws.map((w) => `${w.project}|${w.thread}`)).size,
    rows,
    byModel: by((w) => Object.entries(w.parts).map(([k, v]) => [k.split('|')[0], v])),
    byRole: by((w) => Object.entries(w.parts).map(([k, v]) => { const sub = k.split('|')[1]; return [sub === 'main' ? w.role : sub, v]; })),
    byOrigin: by((w) => [[w.origin, w.usd]]),
    byWarmth: by((w) => [[w.warmth, w.usd]]),
    byProject: by((w) => [[w.project || '-', w.usd]]),
    short: { wakes: short.length, usd: short.reduce((s, w) => s + w.usd, 0) },
    notices: { wakes: ws.filter((w) => w.origin === 'task-notification').length, usd: ws.filter((w) => w.origin === 'task-notification').reduce((s, w) => s + w.usd, 0) },
    cold: { wakes: ws.filter((w) => w.warmth === 'cold').length, usd: ws.filter((w) => w.warmth === 'cold').reduce((s, w) => s + w.usd, 0), penalty: ws.reduce((s, w) => s + (w.coldUsd || 0), 0) },
    topTasks: by((w) => Object.entries(w.tasks || {})).slice(0, 10),
    fable: ws.reduce((s, w) => s + Object.entries(w.parts).filter(([k]) => /fable/i.test(k)).reduce((a, [, v]) => a + v, 0), 0),
    ctxMedian: median(ctxAll), ctxCalls: ctxAll.length,
    ctxAbove: CTX_STEPS.map((n) => [n, ctxUse.filter(([c]) => c > n).reduce((s, [, v]) => s + v, 0), mainTotal]),
    compactions: compactions.length,
    topThreads: threads.slice(0, 10).map(([k, v]) => [k, v, wakesOf.get(k) || 0]),
    topTools: [...tools].sort((a, b) => b.size - a.size).slice(0, 10),
  };
}

export function markdown(s, { calib } = {}) {
  const L = [];
  const t = s.total;
  L.push(`**${usdf(t)} at list price, ${s.wakes} wakes, ${s.threads} threads.**`, '');
  const block = (name, list) => { L.push(`| ${name} | use | share |`, '|---|---:|---:|'); for (const [k, v] of list) L.push(`| ${k} | ${usdf(v)} | ${pct(v, t)} |`); L.push(''); };
  if (s.byProject.length > 1) block('Project', s.byProject);
  block('Model', s.byModel); block('Role', s.byRole); block('Started by', s.byOrigin); block('First call', s.byWarmth);
  L.push(`- Fable's share: ${pct(s.fable, t)}`);
  L.push(`- Waiting share (wakes ending within ${SHORT_CALLS} model calls): ${s.short.wakes} wakes, ${pct(s.short.usd, t)} of use`);
  L.push(`- Wakes started by a background-task notice: ${s.notices.wakes}, ${pct(s.notices.usd, t)} of use`);
  L.push(`- Cold first call after a thread's first wake (the cache had expired): ${s.cold.wakes} wakes holding ${pct(s.cold.usd, t)} of use; writing the cache again cost ${usdf(s.cold.penalty)} (${pct(s.cold.penalty, t)})`);
  L.push(`- Context at a main call: median ${Math.round(s.ctxMedian / 1000)}k tokens over ${s.ctxCalls} calls; share of main-loop use from calls above ${s.ctxAbove.map(([n, v, all]) => `${n / 1000}k: ${pct(v, all)}`).join(', ')}`);
  L.push(`- Compactions: ${s.compactions}`, '');
  L.push('**The largest rows** (project · model · role · started by · first call)', '', '| Row | use | share |', '|---|---:|---:|');
  for (const [k, v] of s.rows.slice(0, 15)) L.push(`| ${k.replace(/\|/g, ' · ')} | ${usdf(v)} | ${pct(v, t)} |`);
  L.push('', '**The 10 heaviest threads**', '', '| Thread | use | share | wakes |', '|---|---:|---:|---:|');
  for (const [k, v, n] of s.topThreads) L.push(`| ${k.replace(/\|/g, ' · ').replace(/^ · /, '')} | ${usdf(v)} | ${pct(v, t)} | ${n} |`);
  if (s.topTasks.length) {
    L.push('', '**The 10 costliest subagent tasks** (by description, digits as #)', '', '| Task | use | share |', '|---|---:|---:|');
    for (const [k, v] of s.topTasks) L.push(`| ${k.replace(/\|/g, '/') || '(none)'} | ${usdf(v)} | ${pct(v, t)} |`);
  }
  L.push('', '**The 10 largest tool results** (characters of text into context; an image counts as one image)', '', '| Size | Thread | Call |', '|---:|---|---|');
  for (const x of s.topTools) L.push(`| ${x.size.toLocaleString('en-US')}${x.images ? ` + ${x.images} image(s)` : ''} | ${x.thread} | \`${x.what.replace(/\|/g, '/').replace(/`/g, "'")}\` |`);
  if (calib) {
    L.push('', `**Calibration (M2):** ${usdf(calib.usd)} between ${calib.since} and ${calib.at} against ${calib.points} points of the week: ${usdf(calib.usdPerPoint)} per point.`);
    for (const [p, n, pts] of calib.perMerged) L.push(`- ${p}: ${n} merged, ${pts.toFixed(2)} points per merged change`);
  }
  return L.join('\n');
}

export function calibrate(ws, { points, at, since, merged = [] }) {
  const usd = ws.filter((w) => w.at >= since && w.at <= at).reduce((s, w) => s + w.usd, 0);
  const usdPerPoint = points ? usd / points : 0;
  const perMerged = merged.map(([p, n]) => { const u = ws.filter((w) => w.project === p && w.at >= since && w.at <= at).reduce((s, w) => s + w.usd, 0); return [p, n, n && usdPerPoint ? u / usdPerPoint / n : 0]; });
  return { usd, points, at, since, usdPerPoint, perMerged };
}

// ---------- command line ----------

function args(argv) {
  const o = { _: [], role: [], merged: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { o._.push(a); continue; }
    const k = a.slice(2);
    if (k === 'md' || k === 'json') { o[k] = true; continue; }
    const v = argv[++i];
    if (k === 'role' || k === 'merged') o[k].push(v); else o[k] = v;
  }
  return o;
}

export function main(argv) {
  const o = args(argv);
  const cmd = o._[0];
  const dirs = o.dir ? [resolve(o.dir)] : [join(homedir(), '.claude', 'projects')];
  if (cmd === 'next' || cmd === 'table') {
    if (!o.from) { console.error('usage: --from <ISO time> is required'); return 2; }
    const rec = readRecords(dirs);
    if (cmd === 'next') {
      if (!rec.threads.size) { console.error('no list_threads (or list_thread_sessions) result found: call it (since --from) first'); return 3; }
      const calls = plan(rec, { from: o.from, to: o.to, max: Number(o.max || 8) });
      for (const c of calls) console.log(JSON.stringify(c));
      console.log(calls.length ? `MORE: ${calls.length} call(s) above` : 'DONE');
      return 0;
    }
    const rules = o.role.map((r) => { const i = r.lastIndexOf('='); return [new RegExp(r.slice(0, i), 'i'), r.slice(i + 1)]; });
    const w = wakes(rec, { from: o.from, to: o.to, project: o.project || '', rules });
    if (!w.wakes.length) { console.error('no wake records in the window'); return 3; }
    if (o.json) { console.log(JSON.stringify(w)); return 0; }
    console.log(markdown(summarize(w)));
    return 0;
  }
  if (cmd === 'merge') {
    const all = { wakes: [], tools: [], compactions: [] };
    const once = new Set(), fresh = (k) => (once.has(k) ? false : (once.add(k), true));
    for (const f of o._.slice(1)) {
      const j = JSON.parse(readFileSync(f, 'utf8'));
      all.wakes.push(...j.wakes.filter((x) => fresh(`w|${x.project}|${x.key}|${x.at}`)));
      all.tools.push(...(j.tools || []).filter((x) => fresh(`t|${x.project}|${x.thread}|${x.at}|${x.what}|${x.size}`)));
      all.compactions.push(...(j.compactions || []).filter((x) => fresh(`c|${x.project}|${x.thread}|${x.at}`)));
    }
    if (o.points && !(o['points-at'] && o.since)) { console.error('usage: --points needs --points-at and --since'); return 2; }
    const inWin = (t) => (!o.from || t >= o.from) && (!o.to || t <= o.to);
    const w = { wakes: all.wakes.filter((x) => inWin(x.at)), tools: all.tools.filter((x) => inWin(x.at)), compactions: all.compactions.filter((x) => inWin(x.at)) };
    if (!w.wakes.length) { console.error('no wake records'); return 3; }
    if (o.json) { console.log(JSON.stringify(w)); return 0; }
    const calib = o.points ? calibrate(all.wakes, { points: Number(o.points), at: o['points-at'], since: o.since, merged: o.merged.map((m) => { const i = m.lastIndexOf('='); return [m.slice(0, i), Number(m.slice(i + 1))]; }) }) : null;
    console.log(markdown(summarize(w), { calib }));
    return 0;
  }
  console.error('usage: usage.mjs next|table --from <ISO> … | merge <file.json> …');
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
