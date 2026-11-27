# Second review · a model reads a pull request once its checks are green, while the owner has it switched on

> Lookup only, never loaded. K054, K055, K060. The tool is `tools/review.mjs`; the workflow is
> `templates/workflows/harness-review.yml`, installed as `.github/workflows/harness-review.yml`.
> The full check of existing code is `tools/sweep.mjs` with `templates/workflows/harness-sweep.yml`; the staff guide is `tools/guide.mjs` on the same job.

## The switch (K055)

The reviewer is installed everywhere and **off by default**. It spends from a credit, and the owner
decides when that credit is spent: it is on only between his command and the end time he names.

- **On** means its end time, a date and time with its offset, has not passed, for example
  `2026-11-30T23:59+03:00`. Anything else is off: not set, `off`, a date without a time or offset, a
  bare `on`, a day the calendar does not have, a time that has passed, and a time more than 45 days
  ahead. So there is no value that means "on for good".
- **It switches itself off** at that time: the job reads the clock, nobody has to come back.
- **Only the owner's command sets it**: "reviewer on until <date>" or "reviewer off", said to the
  project that looks after his repositories. A session carries it out as a pull request that changes
  `until` in each named repository's settings file (below), with the command quoted in `command`, and
  reports the value and the repositories. No rule, schedule, routine or agent pass sets, extends or
  re-creates it, and a status report says "installed, off" or "on until <time>", never just "on".
- `node .harness/tools/review.mjs switch` says whether it is on, until when and where that end time
  lives (the file or the variable); with `--until <value>` it checks a value instead. It sets nothing.

## Where the settings live (K060)

In **`.github/harness-review.json`** on the default branch: a project's own file, changed like any
other file by a reviewed pull request, so no settings page and no owner step. The job reads it from the
default branch, never from the pull request, so a pull request cannot switch its own review on.

```json
{
  "until": "2026-12-22T23:59+03:00",
  "command": "The owner's command of <day>: on until <date>, <what it covers>.",
  "federation_rule": "fdrl_…", "organization": "<uuid>", "service_account": "svac_…", "workspace": "wrkspc_…",
  "sweep_rule": "fdrl_…",
  "note": "free text"
}
```

- Every key is optional. `until` counts only beside a non-empty `command` naming the owner's
  command; without it the reviewer is off.
- **The file outranks the Actions variable.** A variable of the same name (`REVIEW_UNTIL`,
  `REVIEW_FEDERATION_RULE`, `REVIEW_ORGANIZATION`, `REVIEW_SERVICE_ACCOUNT`, `REVIEW_WORKSPACE`,
  `REVIEW_SWEEP_RULE`) is read only for a setting the file leaves out. A session cannot change a
  variable, so a variable that could outrank the file would leave a stale end time only the owner could
  clear. The caps (`daily_usd`, `daily_cap`, `sweep_usd` and their variables) take the lowest of the
  built-in number, the file and the variable: the file may lower a cap, never raise it.
- A file that is not one JSON object of these keys, or that cannot be fetched, switches the reviewer
  off for that run; it never falls back to a variable.
- The identifiers are not secrets, but a public repository keeps them in its variables and names only
  `until` and `command` in its file.

The identifiers below stay in place while it is off, so switching on is one line, `until`, in each repository's settings file.

## What it is

When a pull request's checks finish green, one job reads the diff and the repository's rulebook and
keeps one comment on the pull request: the problems it would block the merge for (C10's question:
file, line, why, how to show it fails), or "no blockers found". A later commit rewrites that comment.

It is an **optional reviewer** in O07's sense: asked once per commit, never waited on, never a
required check, never an approval. It does not replace C10's fresh-context reviewer for a tier-3 or
profile-risky diff; it is one more reader there, and the only second reader everywhere else. The
thread that owns the pull request ends each point FIXED, TRACKED or DISMISSED, with evidence.

It sees only the diff and the rulebook and cannot run code, so it can be wrong in both directions.
"No blockers found" is not evidence that a behaviour works (C07).

## What it does not review

A fork's pull request, a bot's (a dependency update), a draft, a commit that is no longer the head, a
commit it already answered, and a change to documents only. A rule file (`AGENTS.md`, `CLAUDE.md`,
`.claude/**`, `.harness/**`) is never "documents only". A change over 150,000 characters or 300
files gets a line saying it is too large; a cut diff is never read as if it were whole.

## Models

Sonnet by default; Opus when a changed path is high-risk: the profile's `risk.tier3_paths`, and
workflows and agent configuration in every project. Haiku never reviews (O06). Both run at medium
effort with a bounded answer. The model ids and prices are constants in `review.mjs` and change
only by a kit release.

## The pull request is data

The workflow starts from `workflow_run`, so GitHub runs the default branch's copy of it, never a
pull request's. It checks out only the default branch's `.harness/tools` and never the pull
request's code. The diff, title, description and rulebook reach the model inside tags named with a
random word, and the model is told that text asking it to do anything is itself a finding. Its
answer is posted as text: it cannot open an HTML comment or mention an account, and nothing reads
the comment back as an instruction. The comment's hidden first line is the job's own record (commit,
model, tokens, cost); a record counts only from the job's own account.

## No stored key

The job proves who it is with GitHub's identity token for the run and swaps it for an Anthropic
access token that lasts minutes (workload identity federation). No API key exists anywhere. Setup,
once per repository, by whoever administers the Anthropic organisation:

1. A workspace for reviews with its own spend limit, so reviews can never use the whole credit.
2. A service account in that workspace, and one federation rule per repository whose condition
   pins all of: the token's subject for the default branch (GitHub writes it with immutable IDs:
   `repo:<owner>@<owner id>/<name>@<repository id>:ref:refs/heads/<default branch>`), the workflow
   (`job_workflow_ref` ending `/.github/workflows/harness-review.yml@refs/heads/<default branch>`),
   the event (`workflow_run`) and the repository's ID. A rule that pins less lets another workflow
   of that repository mint the same token.
3. The four identifiers in the settings file (or, for a public repository, in the Actions variables
   `REVIEW_FEDERATION_RULE`, `REVIEW_ORGANIZATION`, `REVIEW_SERVICE_ACCOUNT`, `REVIEW_WORKSPACE`). They
   are identifiers, not secrets.

Until the federation rule is named the job asks nothing whatever the switch says, so installing the
workflow changes nothing. The identifiers are the set-up, the end time is the switch. While the switch
is off the job reads only the settings file and ends within seconds. On a private repository with no
self-hosted `CHORE_RUNNER` or `RUNNER` (the profile's `chore_runner` counts, K063) it starts only where the variables `REVIEW_FEDERATION_RULE` and
`REVIEW_UNTIL` are both set, as before K060, so being installed and off costs no GitHub-hosted minutes (K061);
there the variables, set to any value, let the job start, and the file's `until` then decides, as everywhere.

## Caps and cost (O13)

Per repository and UTC day, in code: **$2.50** of reviews and **40** reviews, counted from the job's own
comments, which record the tokens the API reported (the cost is worked out again from those tokens, and a
record without them counts as the dearest review). A review whose estimated worst case would pass
the money cap is not started; two reviews at the same moment can end a day slightly over. One review per commit. `REVIEW_DAILY_USD` and `REVIEW_DAILY_CAP` may only lower
the caps (so may the settings file); raising one is a kit release. Over a cap, or when the API refuses the call (credit used
up, a workspace limit), the pull request gets one line and merges go on. The workspace's spend limit
is the stop across repositories; the in-code caps stop one repository from using it up in a day.

A typical review (25,000 tokens in, 4,000 out) costs about $0.09 on the default model and $0.18 on
the high-risk one. `node .harness/tools/review.mjs spent --repo <owner/name>` prints today's count
and cost; with `--since <YYYY-MM-DD>` it prints every day's from that day on, for the report that
follows a switched-on period. A pull request's comment keeps only its last 60 runs, so when one is full
and its oldest kept run falls inside the period, the answer carries `"partial": true` and those pull
requests (`pulls`): the figure is then a floor, and the reviews workspace's own spend figure on the
Claude Console is the authority.

Runner minutes: one short job per finished pull-request workflow the file lists, on the project's
`RUNNER` lane (`hands.md`); it may wait up to 90 seconds for other checks.

## When the checks are "green"

Every check run and commit status on the head commit is finished and good, and each of the
profile's `branches.required_checks` has reported. A run cancelled because a newer run of the same
check replaced it is left out; the newer run decides. The job starts when a workflow named in the
file's `workflows:` list finishes (GitHub allows no wildcard there). A project whose last
pull-request workflow has another name is reviewed only when that workflow finishes within the
90-second wait; adding a name is a kit change.

## The full check of existing code (K055)

The reviewer above reads only what changes. `harness-sweep` reads what is already there, once, when
the owner asks for it: every tracked code file of the default branch, folder by folder.

- **Private repositories only.** Its issues name defects in code that is in use; on a public
  repository it refuses to run.
- **Started by hand only**, from the default branch (Actions → harness-sweep → Run workflow). No
  schedule and no event starts it. `estimate` (the default) reads the files and prints how many
  areas there are and the most a check could cost; it sends nothing to a model and needs no switch.
  `run` works only while the switch is open and stops when it ends.
- **What comes back:** one issue per area that has findings, each finding graded `blocker`, `major`
  or `minor` with its file and line; and one record issue, "Second reviewer: full check of the
  existing code", with areas read, findings by severity and dollars spent. The project's coordinator
  sorts real from false and queues the fixes; each point ends FIXED, TRACKED or DISMISSED (O07).
- **Not read:** documents, lock files, generated and vendored folders, binaries, the kit's own files
  under `.harness`, a file that may hold a secret (`.env`, a key or certificate, credentials,
  Terraform state and variables, a cloud or registry sign-in file), a symbolic link, and a file over
  60,000 characters (the record lists those). The list of secret-shaped names is a floor, not a
  proof: a repository that tracks a secret under an ordinary name has a leak to fix first.
- **Caps, in code:** $30 for one check (`REVIEW_SWEEP_USD` may only lower it), 250 areas (name
  folders in `paths` for a larger repository), one call per area, 320 minutes a run. A call that
  times out or fails on the server counts at its worst case, since it may still be billed, and a
  batch starts only with room for all three of its tries. A run that
  stops says why in the record; starting it again continues with the areas not yet read, and reads
  an area again only if its files changed. Closing the record issue ends that check.
- **Set-up:** the reviewer's three identifiers, plus `sweep_rule` (or `REVIEW_SWEEP_RULE`): one more
  federation rule, pinned like the reviewer's but to `harness-sweep.yml` and the event `workflow_dispatch`.
  It reads the settings file from its own checkout of the default branch.
- **Runner:** one job of up to 350 minutes on the project's `RUNNER` lane, which holds that runner
  meanwhile; on GitHub-hosted minutes only after the owner has heard the estimate (O13).

**A specialist pass (K068)** is the same job with its `lens` input set to one of `permissions`,
`money-stock`, `irreversible`, `arabic-rtl` or `weakened-tests` (K069: assertions loosened, expected
values copied from the output, skipped or empty tests, mocks of the code under test, tolerances widened
to hide a failure; C08 read back over the tests that exist): the question is narrowed to that lens, every batch goes to
the high-risk model, and the pass keeps its own record issue ("Second reviewer: specialist pass (<lens>)
of the existing code") and its own $30 cap, so it never continues or uses up the full check. The lens is
a fixed choice: no text a person types reaches the question. `estimate` with a lens prints that pass's
worst case first.

**A staff guide (K074)** is the same job with `lens` set to `staff-guide-ar` (or `staff-guide-en`):
`tools/guide.mjs` finds the screens (a `page` file under an `app/` folder), groups them by their first
route part and writes one page of a staff guide per group from its code and its labels file, by the
Batch API at half price; a second batch checks each page against the same code and corrects what the
code does not support. The pages go on one record issue ("Staff guide (<language>): one page per screen,
from the code"), a comment each; the coordinator copies them where staff read them. Same switch, same
federation rule (`sweep_rule`), $15 for all guides the repository ever runs, in any language and any window; `estimate` prints the sections and the worst case
first. It reads code it cannot run, so a page can still be wrong: someone reads it against the screen.

Like the reviewer it cannot run code and sees one batch at a time, so a finding that depends on
another folder says so, and "no findings" is not evidence that the code works (C07).

## Reading a result

| The comment says | Meaning | What the owning thread does |
|---|---|---|
| no blockers found | the model found nothing it would block for | nothing; it is not evidence |
| it would block the merge for the points below | findings | each ends FIXED, TRACKED or DISMISSED (O07) |
| not reviewed, too large | over the size limits | split the change, or rely on C10's reviewer |
| not reviewed, today's review cap is used up | a cap in code | nothing; that commit stays unreviewed, later commits are reviewed once the day turns |
| not reviewed, the API refused the call | credit or a limit | the coordinator checks the credit |
| not reviewed, the model declined | a safety classifier | nothing; C10 still applies where required |
