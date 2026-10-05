// Shared helpers for the kit's tools. No dependencies: Node 20+ only.

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
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
      body = body.replace(/[|>][-+0-9]*\s*(#.*)?$/, JSON.stringify(block.join('\n')));
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

/** Read JSON from GitHub's REST API. Returns { status, data }. Never throws on HTTP errors. */
export async function gh(path) {
  const headers = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'harness-kit' };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;
  try {
    const r = await fetch(`https://api.github.com${path}`, { headers });
    const text = await r.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, data };
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
