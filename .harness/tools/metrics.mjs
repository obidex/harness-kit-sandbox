#!/usr/bin/env node
// metrics — how well the agents work, from GitHub alone (K034; definitions in .harness/metrics.md).
//
//   node .harness/tools/metrics.mjs --repo owner/name [--repo …] [--days 7] [--owner <login>]
//                                   [--now <ISO time>] [--json | --md]
//
// One self-contained file with no imports outside Node, so a host can pin it by one SHA-256 (the
// health page runs it this way). GH_TOKEN (or GITHUB_TOKEN) reads issues, pull requests, checks and
// Actions runs; GITHUB_API_URL points it at a stand-in in tests. It only reads.
//
// Per repository, over the last --days (default 7):
//   agent PRs merged     merged PRs an agent opened: made through an agent app (METRICS_AGENT_APPS,
//                        default "claude") or carrying the claude-projects attribution marker
//   first-pass CI green  of those, the share whose FIRST commit with finished checks had them all
//                        pass (success, neutral or skipped)
//   review BLOCKs        blocks the independent reviewer raised (C10), per PR with a recorded review:
//                        "Round N: K blocks" lines in the PR body and comments; a PR with none counts its
//                        "changes requested" reviews instead
//   false DONEs          work reported done that was not: an agent PR whose merge commit's push run on
//                        the default branch failed, a merged revert, an issue or PR reopened
//   stalls               open now and idle over 24 hours: non-draft PRs, and issues labelled card,
//                        risk:* or inbox
//   owner touches        (needs --owner) writes from the owner's own account that no agent app made and that carry no
//                        hidden <!-- marker -->: issues and PRs opened, comments. An UPPER bound: an agent
//                        writing through a plain token is counted too.
// A section whose reads fail is null ("?" in Markdown), never a zero. A listing cut at its page cap is
// named in `partial`.

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const OK_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);
export const FAILED_RUN = new Set(['failure', 'timed_out', 'startup_failure', 'action_required']);
export const MAX_PRS = 40;          // merged agent PRs read in detail per repository
export const MAX_PAGES = 10;        // pages of 100 for any one listing
export const STALL_HOURS = 24;
const HOUR = 3600000, DAY = 24 * HOUR;
const ATTRIBUTION = /claude-projects-attribution/;

const API = () => (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');
async function get(path) {
  const tok = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const res = await fetch(`${API()}${path}`, {
    headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'harness-metrics', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`GET ${path.split('?')[0]}: HTTP ${res.status}`);
  return res.json();
}
/** Pages of a listing until `stop(item)` says older-than-needed or the cap. → { items, cut } */
async function pages(path, { stop = () => false, max = MAX_PAGES, key } = {}) {
  const items = [];
  for (let p = 1; p <= max; p++) {
    const data = await get(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${p}`);
    const list = key ? data[key] || [] : data;
    for (const it of list) { if (stop(it)) return { items, cut: false }; items.push(it); }
    if (list.length < 100) return { items, cut: false };
  }
  return { items, cut: true };
}

export const isAgent = (item, apps) => apps.includes(item?.performed_via_github_app?.slug) || ATTRIBUTION.test(item?.body || '');
export const hasMarker = (body) => /<!--/.test(String(body || ''));

const WORDS = { no: 0, zero: 0, none: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
/** Blocks per review round from text: "Round 2: 3 blocks", "Round 1 had 3 blocks", "Round 4: no blocks". */
export function reviewRounds(texts) {
  const rounds = new Map();
  for (const t of texts) {
    const plain = String(t || '').replace(/[*_`]/g, '');
    for (const m of plain.matchAll(/\bround\s+(\d{1,2})\b[^\n]{0,60}?\b(\d{1,2}|no|zero|none|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:open\s+)?blocks?\b/gi)) {
      const r = Number(m[1]);
      const k = /^\d+$/.test(m[2]) ? Number(m[2]) : WORDS[m[2].toLowerCase()];
      rounds.set(r, Math.max(rounds.get(r) ?? 0, k));
    }
  }
  return rounds;
}

/** The first-pass verdict of a PR: true (green), false (red) or null (no finished checks found). */
export async function firstPass(repo, shas) {
  for (const sha of shas.slice(0, 5)) {
    const { items } = await pages(`/repos/${repo}/commits/${sha}/check-runs?filter=latest`, { key: 'check_runs', max: 2 });
    const done = items.filter((r) => r.status === 'completed');
    if (done.length) return done.every((r) => OK_CONCLUSIONS.has(r.conclusion));
  }
  return null;
}

async function section(errors, name, fn) {
  try { return await fn(); } catch (e) { errors.push(`${name}: ${e.message}`); return null; }
}

/** The metrics of one repository. */
export async function measure(repo, { now = Date.now(), days = 7, owner = null, apps = ['claude'] } = {}) {
  const start = now - days * DAY;
  const since = new Date(start).toISOString();
  const errors = [], partial = [];
  const out = { repo, window: { start: since, end: new Date(now).toISOString(), days }, errors, partial };

  const recent = await section(errors, 'issues', async () => {
    const r = await pages(`/repos/${repo}/issues?state=all&sort=updated&direction=desc&since=${since}`);
    if (r.cut) partial.push('issues updated in the window');
    return r.items;
  });
  const merged = (recent || []).filter((i) => i.pull_request?.merged_at && Date.parse(i.pull_request.merged_at) >= start);
  const agentPrs = merged.filter((i) => isAgent(i, apps)).sort((a, b) => Date.parse(b.pull_request.merged_at) - Date.parse(a.pull_request.merged_at));
  if (agentPrs.length > MAX_PRS) partial.push(`agent PRs (${MAX_PRS} of ${agentPrs.length} read)`);
  out.agentPrsMerged = recent ? agentPrs.length : null;

  // per merged agent PR: first pass, review blocks, main after the merge
  const detail = recent ? await section(errors, 'pull requests', async () => {
    const rows = [];
    for (const i of agentPrs.slice(0, MAX_PRS)) {
      const pr = await get(`/repos/${repo}/pulls/${i.number}`);
      const commits = (await pages(`/repos/${repo}/pulls/${i.number}/commits`, { max: 3 })).items.map((c) => c.sha);
      const comments = (await pages(`/repos/${repo}/issues/${i.number}/comments`, { max: 3 })).items;
      const reviews = (await pages(`/repos/${repo}/pulls/${i.number}/reviews`, { max: 3 })).items;
      const rounds = reviewRounds([pr.body, ...comments.map((c) => c.body), ...reviews.map((r) => r.body)]);
      const changes = reviews.filter((r) => r.state === 'CHANGES_REQUESTED').length;
      const runs = pr.merge_commit_sha ? (await get(`/repos/${repo}/actions/runs?head_sha=${pr.merge_commit_sha}&event=push&per_page=50`)).workflow_runs || [] : [];
      rows.push({
        number: i.number,
        firstPass: await firstPass(repo, commits),
        reviewed: rounds.size > 0 || changes > 0,
        // a PR that records rounds counts them; "changes requested" counts only where it records none
        blocks: rounds.size ? [...rounds.values()].reduce((s, k) => s + k, 0) : changes,
        mainRed: runs.some((r) => r.status === 'completed' && FAILED_RUN.has(r.conclusion)),
      });
    }
    return rows;
  }) : null;

  if (detail) {
    const measured = detail.filter((d) => d.firstPass !== null);
    const green = measured.filter((d) => d.firstPass).length;
    out.firstPass = { green, measured: measured.length, rate: measured.length ? green / measured.length : null };
    const reviewed = detail.filter((d) => d.reviewed);
    const blocks = reviewed.reduce((s, d) => s + d.blocks, 0);
    out.reviewBlocks = { blocks, reviewedPrs: reviewed.length, perReviewedPr: reviewed.length ? blocks / reviewed.length : null };
  } else { out.firstPass = null; out.reviewBlocks = null; }

  // false DONEs
  const reopened = await section(errors, 'issue events', async () => {
    const r = await pages(`/repos/${repo}/issues/events`, { max: 5, stop: (e) => Date.parse(e.created_at) < start });
    if (r.cut) partial.push('issue events');
    return [...new Set(r.items.filter((e) => e.event === 'reopened' && Date.parse(e.created_at) >= start).map((e) => e.issue?.number))];
  });
  if (detail && reopened && recent) {
    const mainRed = detail.filter((d) => d.mainRed).map((d) => d.number);
    const reverted = merged.filter((i) => /^revert\b/i.test(i.title || '')).map((i) => i.number);
    out.falseDone = { total: mainRed.length + reverted.length + reopened.length, mainRed, reverted, reopened };
  } else out.falseDone = null;

  // stalls: open and idle over 24 h
  out.stalls = await section(errors, 'open items', async () => {
    const r = await pages(`/repos/${repo}/issues?state=open&sort=updated&direction=asc`, { max: 5 });
    if (r.cut) partial.push('open items');
    const idle = (i) => now - Date.parse(i.updated_at) > STALL_HOURS * HOUR;
    const watched = (i) => (i.pull_request ? !i.draft : (i.labels || []).some((l) => /^(card|inbox|risk:.+)$/.test(typeof l === 'string' ? l : l.name)));
    const items = r.items.filter((i) => watched(i) && idle(i)).map((i) => i.number);
    return { count: items.length, items };
  });

  // owner touches (upper bound)
  const comments = await section(errors, 'comments', async () => {
    const r = await pages(`/repos/${repo}/issues/comments?sort=created&direction=desc&since=${since}`);
    if (r.cut) partial.push('comments');
    return r.items;
  });
  if (!owner) { errors.push('owner touches: no --owner given'); out.ownerTouches = null; } else if (recent && comments) {
    const human = (x) => x.user?.login === owner && !x.performed_via_github_app && !hasMarker(x.body) && Date.parse(x.created_at) >= start;
    const count = recent.filter(human).length + comments.filter(human).length;
    out.ownerTouches = { count, perWeek: Math.round((count * 7 * 10) / days) / 10 };
  } else out.ownerTouches = null;
  return out;
}

const pct = (x) => (x === null || x === undefined ? '?' : `${Math.round(100 * x)}%`);
const num = (x) => (x === null || x === undefined ? '?' : String(Math.round(x * 10) / 10));
/** Markdown for a public page: counts only, never titles or names of people. */
export function render(results, { days = 7 } = {}) {
  const rows = results.map((m) => [
    m.repo,
    num(m.agentPrsMerged),
    m.firstPass ? `${pct(m.firstPass.rate)} (${m.firstPass.green}/${m.firstPass.measured})` : '?',
    m.reviewBlocks ? `${num(m.reviewBlocks.perReviewedPr)} (${m.reviewBlocks.blocks} in ${m.reviewBlocks.reviewedPrs})` : '?',
    m.falseDone ? num(m.falseDone.total) : '?',
    m.stalls ? num(m.stalls.count) : '?',
    m.ownerTouches ? num(m.ownerTouches.perWeek) : '?',
  ]);
  const lines = [
    `| Repository | Agent PRs merged | First-pass CI green | Review BLOCKs per reviewed PR | False DONEs | Stalls now (idle > 24 h) | Owner touches a week (at most) |`,
    '|---|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.join(' | ')} |`),
    '',
    `Last ${days} days. Definitions: the kit's \`.harness/metrics.md\`. "?" means GitHub could not be read for it, never zero.`,
  ];
  const notes = results.flatMap((m) => [...m.errors.map((e) => `${m.repo}: ${e}`), ...m.partial.map((p) => `${m.repo}: partial, ${p}`)]);
  if (notes.length) lines.push('', ...notes.map((x) => `- ${x.replace(/\|/g, '/')}`));
  return lines.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const all = (k) => args.flatMap((a, i) => (args[i - 1] === k ? [a] : []));
  const one = (k) => all(k)[0];
  const repos = all('--repo');
  if (!repos.length || repos.some((r) => !/^[\w.-]+\/[\w.-]+$/.test(r))) { console.error('usage: metrics.mjs --repo owner/name [--repo …] [--days 7] [--owner login] [--now ISO] [--json|--md]'); process.exit(2); }
  const days = Number(one('--days') || 7);
  if (!(days > 0 && days <= 31)) { console.error('metrics: --days is 1 to 31'); process.exit(2); }
  const now = one('--now') ? Date.parse(one('--now')) : Date.now();
  const apps = (process.env.METRICS_AGENT_APPS || 'claude').split(',').map((s) => s.trim()).filter(Boolean);
  const results = [];
  for (const repo of repos) results.push(await measure(repo, { now, days, owner: one('--owner') || null, apps }));
  console.log(args.includes('--json') ? JSON.stringify(results, null, 2) : render(results, { days }));
  // exit 1 only when nothing at all could be read: a partial page is still a page
  if (results.every((m) => m.agentPrsMerged === null && m.stalls === null)) process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(`metrics: ${e.message}`); process.exit(1); });
