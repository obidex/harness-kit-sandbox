# Harness Kit · measuring the agents

> Lookup only, never loaded. K034 (roadmap #48, P7). Three measures: numbers from GitHub on a
> health page, a token budget for what every session loads, and a frozen replay set for rule and
> model changes. None of them spends money or runs AI on a machine.

## 1. The numbers (`tools/metrics.mjs`)

`node .harness/tools/metrics.mjs --repo owner/name [--repo …] [--days 7] [--owner <login>]` reads
GitHub (GH_TOKEN; issues, pull requests, checks and Actions runs, read only) and prints one Markdown
row per repository, counts only, safe for a public page. `--json` gives the detail with numbers.
It is one file with no imports outside Node, so a host pins it by its SHA-256.

| Metric | Exactly what is counted (last `--days`, default 7) | What it tells |
|---|---|---|
| Agent PRs merged | merged PRs made through an agent app (`METRICS_AGENT_APPS`, default `claude`) or carrying the `claude-projects-attribution` marker | the volume the rest is a share of |
| First-pass CI green | of those, the share whose first commit with finished checks had every check pass (success, neutral, skipped); a PR whose first five commits had none is left out | work that was right before CI said so (C07) |
| Review BLOCKs per reviewed PR | `Round N: K blocks` lines in the PR body and comments (each round counted once, at its highest); a PR with no such line counts its "changes requested" reviews instead; divided by the PRs with either (an approval alone records no review) | how much the independent review catches (C10) |
| False DONEs | an agent PR whose merge commit's push run on the default branch failed (C13), a merged PR titled `Revert`, an issue or PR reopened | work reported done that was not |
| Stalls | open now and idle over 24 hours: non-draft PRs, issues labelled `card`, `inbox` or `risk:*` | silent stalls (C04, C15), stricter than the stale-work list |
| Owner touches a week | (only with `--owner <login>`; without it "?") the owner's own-account issues, PRs and comments that no agent app made and that carry no hidden `<!-- -->` marker, scaled to 7 days | how much the owner still has to do by hand (O01, O17) |

Limits, said on the page: "?" means GitHub could not be read for it, never zero. Owner touches are
an upper bound: an agent writing through a plain token on the owner's account looks like him. Review
blocks count only what the PR records in the `Round N: K blocks` form (the form PRs already use).
Listings are capped (40 PRs, 10 pages); a cut listing is named as partial.

**How to record a review so it counts:** one line per round in the PR body or a comment, such as
`Round 1: 3 blocks (…)` and `Round 2: no blocks`.

## 2. The token budget (`tools/load.mjs`, audit C17)

What a session loads before its first word: `CLAUDE.md` (or `.claude/CLAUDE.md`), every file it
imports with `@path` (recursively, at most 5 hops, never inside code), and every `.claude/rules/**/*.md`
without `paths:` frontmatter. Rules with `paths:` load only for matching files: they are listed, not
counted. Tokens are estimated as UTF-8 bytes / 3.5, rounded up (no tokenizer, errs high).

The budget is `profile.canon.load_budget_tokens`, default **8000**. The audit's C17 FAILs over it, so
`harness-audit` checks it on every PR that touches `CLAUDE.md`, `AGENTS.md`, `.claude/**` or
`.harness/**`. The kit keeps its own share (a fresh install) at most half the default
(`check-kit`). `node .harness/tools/load.mjs` lists the set; a project over budget moves text to
lookup files or path-scoped rules, it does not raise the number without a decision.

## 3. The replay (`replay/` in the kit repository)

A frozen set of 20-50 past incidents, rewritten without project names, each a multiple-choice
situation graded deterministically. A kit release that changes `core.md`, `owner-defaults.md` or an
adapter (A23 names the models) carries `replay/results/<version>.json`, made by fresh agents on the
new text and re-graded by CI. How to run it: `replay/README.md` in the kit repository.
