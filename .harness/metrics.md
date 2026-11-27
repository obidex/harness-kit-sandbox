# Harness Kit · measuring the agents

> Lookup only, never loaded. K034 (roadmap #48, P7). Three measures, and where runner time goes (§4, K078): numbers from GitHub on a
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
| Sat green before merge | of the merged agent PRs, minutes from the moment every check on the merged head had finished green to the merge: the newest run of each check name that started before the merge counts (an older run it replaced does not; one that started after the merge is left out); a PR merged beside a check still running or red is not measured. Known limits: commit statuses (as opposed to check runs) are not counted, and a check re-run after the merge hides its pre-merge run, so that PR is left out. The median, and how many sat over 30 minutes (K069) | whether threads are there when their checks go green; auto-merge (A06) should hold it near zero |
| False DONEs | an agent PR whose merge commit's push run on the default branch failed (C13), a merged PR titled `Revert`, an issue or PR reopened | work reported done that was not |
| Stalls | open now and idle over 24 hours: non-draft PRs, issues labelled `card`, `inbox` or `risk:*` | silent stalls (C04, C15), stricter than the stale-work list |
| Answered, not closed | open issues labelled `inbox` whose State line says `done`, or whose newest comment that no bot wrote has a line opening with `DONE` (C03); at most 60 read, more is named as partial (K071) | requests finished but left open, which inflate every queue count |
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

## 4. Repeated CI runs (`tools/ci-repeats.mjs`, K078)

`node .harness/tools/ci-repeats.mjs --repo owner/name [--repo …] [--days 7] [--max-calls 1500]` reads
the window's runs and every attempt of their jobs; a host that already reads them (the VPS's minutes
count) hands its records over with `--runs FILE --jobs FILE [--pulls FILE]` and spends no call of its
own. Reading costs one call per run: a busy week of six repositories is several thousand calls of the
account's shared hourly limit, so the reader stops at `--max-calls` and says partial.

Each job attempt is counted once, as runner minutes (`completed - started`; a job GitHub dropped while
it waited has a start time but no runner and counts 0), in exactly one cause, so the causes add up to
the total. "Cancelled" is a flag inside a cause, never a cause of its own.

| Cause | Exactly what | Avoidable |
|---|---|---|
| same | content already tested: the same job had passed on it, or already held a runner on it (a re-run of a passed job; a pull request run again with neither its head nor its base moved, after an edited title, an empty commit or a reopen; the default branch on a tree its pull request already tested green) | yes |
| retry | the same content again after the same job failed on it | no (a flake's cost) |
| bot | a bot's commit pushed on top of a person's pull request (generated files) | yes |
| base | a merge of the default branch into the pull request, or the same head again after the default branch moved | no: a new combination |
| main | the default branch on content no run had tested | no |
| change | a pull request's own new content (a bot's own pull request, such as a kit update, included) | no |
| other | what no change started: schedules, issues, comments, dispatches, `workflow_run` | not counted as CI |

Content: a pull request run tests its head on the base of that moment (the newest default-branch head
seen before it); the default branch tests its tree. A pull request run that passed also covers its head
tree for the default branch: the default branch reaches exactly that tree only when the head already
held the base it was tested on. Runs are tied to their pull request by branch while that pull request
was open (GitHub's run listing often leaves the number out), never by branch alone.

| Number | Exactly what |
|---|---|
| Avoidable runner-hours a week | same + bot, scaled to 7 days; also as a share of CI time (all but other) |
| Ready to green | per pull request merged in the window (its default-branch run's "(#N)"): from the first run on its last own commit (neither a merge of the base nor a bot's) to when the newest run of each workflow on its merged head had finished green; median and p90 |
| Check runs per merged change | runs of the project's check (its biggest pull-request workflow, the kit's chores left out) on the pull request and its merge |
| Merged a day | the guard beside every fix: it must not fall |

Limits: a restart counts in full as same, though only the cancelled part was lost; a push to a tag counts as a
change; a re-run started more than two days after its run is not seen by a host that closes days;
commit statuses are not runs; a project whose squash commits drop "(#N)" has no ready-to-green.

## 5. First pass and its causes (`tools/ci-repeats.mjs`, K079)

One number per project, weekly, in the status feed beside §4: **first pass**, the share of ready changes whose
first judged head passed every workflow on its first attempt. A ready change is a pull request whose first run
started in the window; its first judged head is the first head whose runs all finished and were not cancelled (a
head the next push cancelled is not judged). A head whose commit says it fails on purpose ("expected to fail",
"deliberately failing", "fails on purpose", "[expect-fail]") is left out, so a failure that proves a test works
never lowers the rate.

Each failed first pass carries exactly one cause, taken in this order:

| Cause | When | What it asks for |
|---|---|---|
| infrastructure | a failed job had no runner or timed out, the run could not start, or it failed with no failed job | the runner, GitHub or the network: the platform's card |
| unreliable test | a re-run of the same attempt passed, or a later run of the same workflow on the same tree passed | the test: measure against a baseline taken in the same job, or count work instead of time |
| old finding under a new rule | a kit update branch (`harness/kit-*`), or a workflow already red on the default branch before the pull request's first run | the rule's release: tried on the projects first (`trial.mjs`) |
| product defect | the rest: a new commit fixed it | nothing new: this is what checks are for |

The second time a known cause appears, the card that fixes it is a prevention, not another investigation: file it
as a papercut with `--cause` (`papercuts.md`), and the weekly digest lists the known causes in one place.

Limits: one cause per change, from its first failed workflow; a run whose jobs were not read is judged by its
conclusion; a pull request whose runs carry no number and whose branch matches no listed pull request is not seen.
