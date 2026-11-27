// Shared helpers for the kit's tools. No dependencies: Node 20+ only.

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, existsSync, appendFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
export const fileHash = (p) => sha256(readFileSync(p));

/** Every file under dir (recursive), as paths relative to base, sorted. */
export function walk(dir, base = dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, base));
    else out.push(relative(base, p));
  }
  return out.sort();
}

// --- the chore lane's repository setting (K063) ----------------------------------------------------
// GitHub decides a job's runner before any step runs, so a workflow cannot read a file for its
// `runs-on`. The kit writes the setting into its installed workflows instead: with the profile's
// `chore_runner` set, every `vars.CHORE_RUNNER` in a kit workflow's expressions is installed as
// `(vars.CHORE_RUNNER || '<label>')`, so the file decides and the variable, when set, overrides it.
// Comment lines are left as they are. unrenderLane undoes it exactly (the templates never hold the
// rendered form), so `harness.mjs lanes` and the checks can rebuild a workflow for any setting.
export const LANE_FILE_RE = /^\.github\/workflows\/harness-[a-z0-9-]+\.ya?ml$/;
export const LANE_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RENDERED_RE = /\(vars\.CHORE_RUNNER \|\| '([A-Za-z0-9][A-Za-z0-9._-]{0,63})'\)/g;
const isComment = (line) => /^\s*#/.test(line);

/** The profile's chore lane label, or null when it names none. Throws on a label GitHub could not use. */
export function choreLane(profile) {
  const v = profile?.chore_runner;
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || !LANE_LABEL_RE.test(v)) throw new Error(`chore_runner ${JSON.stringify(v)} is not a runner label (${LANE_LABEL_RE})`);
  return v;
}
/** A kit workflow as installed for a chore lane label (null: the template unchanged). */
export function renderLane(text, label) {
  if (!label) return text;
  if (!LANE_LABEL_RE.test(label)) throw new Error(`not a runner label: ${label}`);
  return text.split('\n').map((l) => (isComment(l) ? l : l.replace(/\bvars\.CHORE_RUNNER\b/g, `(vars.CHORE_RUNNER || '${label}')`))).join('\n');
}
/** The template an installed kit workflow was rendered from. */
export function unrenderLane(text) {
  return text.split('\n').map((l) => (isComment(l) ? l : l.replace(RENDERED_RE, 'vars.CHORE_RUNNER'))).join('\n');
}
/** The label an installed workflow carries (null: none), or undefined when its lines disagree. */
export function laneIn(text) {
  const found = new Set(text.split('\n').filter((l) => !isComment(l)).flatMap((l) => [...l.matchAll(RENDERED_RE)].map((m) => m[1])));
  const bare = text.split('\n').some((l) => !isComment(l) && /\bvars\.CHORE_RUNNER\b(?! \|\| ')/.test(l));
  if (found.size > 1 || (found.size === 1 && bare)) return undefined;
  return found.size ? [...found][0] : null;
}

// --- JSON Schema: the subset profile.schema.json uses -------------------------------------------
const typeOk = (t, v) => ({ object: v !== null && typeof v === 'object' && !Array.isArray(v), array: Array.isArray(v),
  string: typeof v === 'string', integer: Number.isInteger(v), boolean: typeof v === 'boolean', number: typeof v === 'number' }[t]);

/** Returns a list of error strings; empty means valid. */
export function validateSchema(schema, value) {
  const errors = [];
  const err = (path, msg) => errors.push(`${path}: ${msg}`);
  (function v(s, x, path) {
    if (s.enum && !s.enum.includes(x)) return err(path, `${JSON.stringify(x)} not in ${s.enum.join(', ')}`);
    if (s.type && !typeOk(s.type, x)) return err(path, `expected ${s.type}`);
    if (typeof x === 'string') {
      if (s.minLength && x.length < s.minLength) err(path, 'too short');
      if (s.maxLength !== undefined && x.length > s.maxLength) err(path, `longer than ${s.maxLength}`);
      if (s.pattern && !new RegExp(s.pattern).test(x)) err(path, `does not match ${s.pattern}`);
    }
    if (typeof x === 'number' && s.minimum !== undefined && x < s.minimum) err(path, `below ${s.minimum}`);
    if (typeof x === 'number' && s.maximum !== undefined && x > s.maximum) err(path, `above ${s.maximum}`);
    if (Array.isArray(x)) {
      if (s.minItems && x.length < s.minItems) err(path, `fewer than ${s.minItems} items`);
      if (s.maxItems !== undefined && x.length > s.maxItems) err(path, `more than ${s.maxItems} items`);
      if (s.uniqueItems && new Set(x.map((y) => JSON.stringify(y))).size !== x.length) err(path, 'items repeat');
      if (s.items) x.forEach((y, i) => v(s.items, y, `${path}[${i}]`));
    }
    if (typeOk('object', x)) {
      for (const k of s.required || []) if (!(k in x)) err(path, `missing ${k}`);
      for (const [k, y] of Object.entries(x)) {
        if (s.properties && k in s.properties) v(s.properties[k], y, `${path}.${k}`);
        else if (s.additionalProperties === false) err(path, `unknown key ${k}`);
        else if (typeof s.additionalProperties === 'object') v(s.additionalProperties, y, `${path}.${k}`);
      }
    }
  })(schema, value, '$');
  return errors;
}

// --- A small YAML reader for GitHub workflow files ------------------------------------------------
// Handles block mappings and block lists by indentation, which is all workflow files need for the
// audit's questions. Scalars stay strings; flow collections (`[a, b]`, `{}`) stay raw strings;
// block scalars (`|`, `>`) become their joined text. Comments and blank lines are dropped.
export function parseYaml(text) {
  const lines = [];
  const raw = text.split('\n');
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i];
    if (/^\s*(#.*)?$/.test(line)) continue;
    const indent = line.match(/^ */)[0].length;
    let body = line.slice(indent);
    // block scalar: swallow the following more-indented lines
    if (/(:|^-)\s*[|>][-+0-9]*\s*(#.*)?$/.test(body)) {
      const block = [];
      while (i + 1 < raw.length && (/^\s*$/.test(raw[i + 1]) || raw[i + 1].match(/^ */)[0].length > indent)) block.push(raw[++i].trim());
      body = body.replace(/[|>][-+0-9]*\s*(#.*)?$/, () => JSON.stringify(block.join('\n'))); // a function: a block's `$'` or `$&` is text, not a replacement pattern
    }
    lines.push({ indent, body });
  }
  let pos = 0;
  const unquote = (s) => {
    s = s.replace(/\s+#.*$/, '').trim();
    if (/^".*"$/.test(s)) { try { return JSON.parse(s); } catch { return s.slice(1, -1); } }
    if (/^'.*'$/.test(s)) return s.slice(1, -1).replace(/''/g, "'");
    return s;
  };
  const keyOf = (body) => body.match(/^("[^"]*"|'[^']*'|[^:]+?):(\s+|$)(.*)$/);
  function node(indent) {
    if (pos >= lines.length) return null;
    return lines[pos].body.startsWith('- ') || lines[pos].body === '-' ? list(lines[pos].indent) : map(lines[pos].indent);
  }
  function map(indent) {
    const out = {};
    for (;;) {
      while (pos < lines.length && lines[pos].indent > indent) pos++; // orphaned deeper lines
      if (!(pos < lines.length && lines[pos].indent === indent && !lines[pos].body.startsWith('- '))) break;
      const m = keyOf(lines[pos].body);
      if (!m) { pos++; continue; }
      const key = unquote(m[1]);
      const rest = m[3].replace(/^&\S+\s*/, ''); // an anchor (`&name`) only labels the value
      pos++;
      if (rest.trim() === '' || rest.trim().startsWith('#')) {
        out[key] = pos < lines.length && (lines[pos].indent > indent || (lines[pos].indent === indent && lines[pos].body.startsWith('- '))) ? node(lines[pos].indent) : null;
      } else out[key] = unquote(rest);
    }
    return out;
  }
  function list(indent) {
    const out = [];
    while (pos < lines.length && lines[pos].indent === indent && (lines[pos].body.startsWith('- ') || lines[pos].body === '-')) {
      const item = lines[pos].body.replace(/^-\s?/, '');
      if (item === '') { pos++; out.push(pos < lines.length && lines[pos].indent > indent ? node(lines[pos].indent) : null); continue; }
      if (keyOf(item) && !/^["']/.test(item)) {
        // a mapping that starts on the dash line: re-read it as a map at the item's indent
        lines[pos] = { indent: indent + 2, body: item };
        out.push(map(indent + 2));
      } else { out.push(unquote(item)); pos++; }
    }
    return out;
  }
  return node(0) || {};
}

/** `on:` keys of a workflow (YAML may read `on` as the key "on" or the raw string). */
export function triggers(wf) {
  const on = wf.on ?? wf.true ?? wf['"on"'];
  if (typeof on === 'string') return on.replace(/[[\]]/g, '').split(',').map((s) => s.trim()).filter(Boolean);
  if (Array.isArray(on)) return on;
  return on ? Object.keys(on) : [];
}

// --- GitHub's REST API ------------------------------------------------------------------------------
// The one client of the tools a project installs as the whole folder. Hosts that fetch single files by
// pin get no lib.mjs, so those files keep their own: inbox.mjs holds an exact copy of ghCall, ghClient
// and ghPages for itself, ask.mjs and explain.mjs (test-inbox checks the copy and each set's imports),
// and metrics.mjs and notify.mjs, each fetched alone, keep theirs.

/** One call. Never throws on an HTTP answer: `{ status, data, text }`, data the parsed JSON (null when
 *  the answer is empty, the text when it is not JSON, always the text with `raw`). No token, no header.
 *  A read (GET, HEAD) that meets GitHub's own hiccup, a 500, 502, 503 or 504 or no answer at all, is
 *  tried again: three tries in all, 2 s then 4 s apart (HARNESS_GH_RETRY_MS sets the step; the tests use
 *  0), each retry one line on stderr; the last answer stands, and no answer at the last try throws as
 *  before (K075). A write is sent once: a 502 does not say it did not land, and a second comment, label
 *  or merge is worse than a red run that the next run repeats. */
export async function ghCall(method, path, data, { agent = 'harness-kit', token, accept = 'application/vnd.github+json', raw = false } = {}) {
  const tries = method === 'GET' || method === 'HEAD' ? 3 : 1;
  const step = Number(process.env.HARNESS_GH_RETRY_MS ?? 2000);
  for (let n = 1; ; n++) {
    let status, text;
    try {
      const r = await fetch(`${process.env.GITHUB_API_URL || 'https://api.github.com'}${path}`, {
        method,
        headers: { accept, 'x-github-api-version': '2022-11-28', 'user-agent': agent,
          ...(token ? { authorization: `Bearer ${token}` } : {}), ...(data ? { 'content-type': 'application/json' } : {}) },
        body: data ? JSON.stringify(data) : undefined,
      });
      status = r.status;
      text = await r.text();
    } catch (e) {
      if (n >= tries) throw e;
      status = `got no answer (${String(e.cause?.code || e.message).slice(0, 80)})`;
    }
    if (typeof status === 'number' && (n >= tries || ![500, 502, 503, 504].includes(status))) {
      let json = text;
      if (!raw) { try { json = text ? JSON.parse(text) : null; } catch { /* not JSON: the text */ } }
      return { status, data: json, text };
    }
    const ms = (Number.isFinite(step) && step >= 0 ? step : 2000) * n;
    console.error(`${agent}: ${method} ${path.split('?')[0]} ${typeof status === 'number' ? `answered ${status}` : status}, a GitHub hiccup; trying again in ${ms / 1000} s (try ${n + 1} of ${tries})`);
    await new Promise((done) => setTimeout(done, ms));
  }
}

/** A tool's client, `(method, path, data, { accept, raw })`: the data of a 2xx answer. Any other answer
 *  throws an Error with `status` that names the method, the path without its query and the status, with
 *  the answer's first 300 characters and the tool's `hint(status, path)`. The token is read at each call. */
export const ghClient = (agent, { token = () => process.env.GH_TOKEN, hint = () => '' } = {}) => async (method, path, data, opts = {}) => {
  const r = await ghCall(method, path, data, { ...opts, agent, token: token() });
  if (r.status < 200 || r.status > 299) {
    const e = new Error(`${method} ${path.split('?')[0]} answered ${r.status}: ${r.text.slice(0, 300)}${hint(r.status, path)}`);
    e.status = r.status;
    throw e;
  }
  return r.data;
};

/** Every item of a listing, 100 a page, at most `max` pages: `{ items, cut }`, cut when the last page read
 *  was full (there may be more). `key` names the list inside an object answer. An answer that is not a
 *  list throws: a check never passes on a page it could not read. */
export async function ghPages(call, path, { max = 10, key } = {}) {
  const items = [];
  for (let page = 1; page <= max; page++) {
    const got = await call('GET', `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    const l = key ? got?.[key] : got;
    if (!Array.isArray(l)) throw new Error(`GET ${path.split('?')[0]} answered no list${key ? ` in "${key}"` : ''}`);
    items.push(...l);
    if (l.length < 100) return { items, cut: false };
  }
  return { items, cut: true };
}

/** Read JSON from GitHub with GITHUB_TOKEN (else GH_TOKEN): `{ status, data }`. Never throws, also not
 *  when GitHub cannot be reached (status 0). */
export async function gh(path) {
  try {
    const { status, data } = await ghCall('GET', path, null, { token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN });
    return { status, data };
  } catch (e) {
    return { status: 0, data: String(e) };
  }
}

/** GitHub's parser is strict YAML and parseYaml is not: a plain value holding ": " makes the whole
 *  workflow invalid (it never runs, so it cannot alert). One message per offending line. */
export function plainValueProblems(text) {
  const out = [];
  for (const [n, line] of String(text).split('\n').entries()) {
    const m = line.match(/^\s*(?:-\s+)?[\w.-]+:\s+([^|>'"\s].*)$/);
    if (m && /:\s/.test(m[1].replace(/\s+#.*$/, ''))) out.push(`line ${n + 1}: a plain value contains ": " (quote it or use a block scalar)`);
  }
  return out;
}

/** One plain failure line, where people and the status feed read it (K079): on GitHub Actions an error
 *  annotation (the check run's annotations, which the REST API returns) and the job summary's first lines;
 *  anywhere, stderr. `check`: the check's name as the project sees it; `line`: one sentence, what failed and
 *  the next step. Long lines are cut at 300 characters; a newline becomes a space. */
export function plainFail(check, line) {
  const one = String(line || '').replace(/\s*\n\s*/g, ' ').trim().slice(0, 300);
  const esc = (x) => String(x).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  if (process.env.GITHUB_ACTIONS === 'true') {
    process.stdout.write(`::error title=${esc(check).replace(/[:,]/g, ' ')}::${esc(one)}\n`);
    if (process.env.GITHUB_STEP_SUMMARY) { try { appendFileSync(process.env.GITHUB_STEP_SUMMARY, `**${check} failed:** ${one}\n\n`); } catch { /* the summary is a convenience */ } }
  }
  console.error(`${check}: FAILED: ${one}`);
  return one;
}
