# Second review · a model reads a pull request once its checks are green, while the owner has it switched on

> Lookup only, never loaded. K054, K055. The tool is `tools/review.mjs`; the workflow is
> `templates/workflows/harness-review.yml`, installed as `.github/workflows/harness-review.yml`.
> The full check of existing code is `tools/sweep.mjs` with `templates/workflows/harness-sweep.yml`.

## The switch (K055)

The reviewer is installed everywhere and **off by default**. It spends from a credit, and the owner
decides when that credit is spent: it is on only between his command and the end time he names.

- **On** means the Actions variable `REVIEW_UNTIL` holds a date and time with its offset that has
  not passed, for example `2026-11-30T23:59+03:00`. Anything else is off: not set, a date without a
  time or offset, a bare `on`, a day the calendar does not have, a time that has passed, and a time
  more than 45 days ahead. So there is no value that means "on for good".
- **It switches itself off** at that time: the job reads the clock, nobody has to come back.
- **Only the owner's command sets it**: "reviewer on until <date>" or "reviewer off", said to the
  project that looks after his repositories. A session then sets or deletes `REVIEW_UNTIL` in each
  repository he named (Settings → Secrets and variables → Actions → Variables) and reports the value
  and the repositories. No rule, schedule, routine or agent pass sets, extends or re-creates it, and
  a status report says "installed, off" or "on until <time>", never just "on".
- `node .harness/tools/review.mjs switch --until <value>` checks a value before it is set and prints
  when it ends in UTC; it sets nothing.

The identifiers below stay in place while it is off, so switching on is one variable per repository.

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
3. Four Actions variables in the repository: `REVIEW_FEDERATION_RULE`, `REVIEW_ORGANIZATION`,
   `REVIEW_SERVICE_ACCOUNT`, `REVIEW_WORKSPACE`. They are identifiers, not secrets.

Until `REVIEW_FEDERATION_RULE` is set the job is skipped whatever the switch says, so installing the
workflow changes nothing. The identifiers are the set-up, `REVIEW_UNTIL` is the switch.

## Caps and cost (O13)

Per repository and UTC day, in code: **$2.50** of reviews and **40** reviews, counted from the job's own
comments, which record the tokens the API reported (the cost is worked out again from those tokens, and a
record without them counts as the dearest review). A review whose estimated worst case would pass
the money cap is not started; two reviews at the same moment can end a day slightly over. One review per commit. `REVIEW_DAILY_USD` and `REVIEW_DAILY_CAP` may only lower
the caps; raising one is a kit release. Over a cap, or when the API refuses the call (credit used
up, a workspace limit), the pull request gets one line and merges go on. The workspace's spend limit
is the stop across repositories; the in-code caps stop one repository from using it up in a day.

A typical review (25,000 tokens in, 4,000 out) costs about $0.09 on the default model and $0.18 on
the high-risk one. `node .harness/tools/review.mjs spent --repo <owner/name>` prints today's count
and cost; with `--since <YYYY-MM-DD>` it prints every day's from that day on, for the report that
follows a switched-on period.

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
- **Set-up:** the reviewer's three identifiers, plus `REVIEW_SWEEP_RULE`: one more federation rule,
  pinned like the reviewer's but to `harness-sweep.yml` and the event `workflow_dispatch`.
- **Runner:** one job of up to 350 minutes on the project's `RUNNER` lane, which holds that runner
  meanwhile; on GitHub-hosted minutes only after the owner has heard the estimate (O13).

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
