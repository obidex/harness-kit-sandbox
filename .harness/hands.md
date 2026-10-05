# Harness Kit · the hands App in operation

> Lookup only, never loaded by default. How settings as code runs day to day (A14, K007, K008), the
> emergency stop, kit update PRs against a project's PR guards, and what each kit workflow costs in
> GitHub-hosted minutes (O13).

## When settings are applied

`hands-settings` in the control repository applies a project's `.github/harness-settings.json`:

1. **After a settings PR merges.** The session that merged it dispatches `hands-settings` on the
   control repository's `main` with `repo` set to the project (`workflow_dispatch`). This is the
   authorized trigger: only someone with write access to the control repository can start it, it
   runs the reviewed workflow at the pinned kit, and the key never leaves the `hands` environment.
   The session then reads the run's summary: `applied …` lines, then `read back, live settings
   match the file`.
2. **Once a day, a drift check.** One read-only job compares every enrolled repository with its
   file. A repository that matches gets no job; one that differs gets one apply job, which writes,
   reads the settings back and fails unless they match. A click in GitHub's settings is therefore
   undone within a day, and the hands log records it.

A settings PR that merges and is never dispatched is still applied by the next daily check.

## Before a settings change merges

Run `hands.mjs plan --repo <owner/name> --file .github/harness-settings.json` with a token that can
read the repository's administration settings, and quote its lines in the PR. A first enrollment
(a mirror) must plan nothing, or only the changes the PR names. Pruning (`prune`) stays off unless
the PR is about deleting: with it off, rulesets and labels the file does not name are never
touched, and a ruleset's bypass list the file leaves out is kept as it is.

## Emergency: pause, repair, agree, resume

Use this when the file is wrong and a live setting must change before a PR can merge (for example
a ruleset blocks every merge, including the fix).

1. **Pause.** In the control repository, set the Actions variable `HANDS_PAUSED` to the project
   (`owner/name`; several separated by commas; `*` for all): Settings → Secrets and variables →
   Actions → Variables. From then on the drift check skips it and an apply refuses it.
2. **Repair** the live setting by hand in the project's GitHub settings.
3. **Bring the file into agreement.** Export the live settings
   (`hands.mjs export --repo owner/name`), open a PR that makes `.github/harness-settings.json`
   match them, and merge it on its gates. `plan` must now say `matches its settings file`.
4. **Resume.** Remove the project from `HANDS_PAUSED`, dispatch `hands-settings` for it, and check
   the summary says it matches. Record the incident in the hands log issue.

Never resume before step 3: the next run would restore the broken setting.

## Kit update PRs and a project's own PR guards

A project whose CI requires a body line on PRs that touch `.github/**` or `.claude/**` (for example
`Tier-3: authorized by card #12`) would block every unattended kit update. It names the standing
authorization lines in its profile, `kit_updates.pr_body_lines` (at most 10, each at most 200
characters of letters, digits, space and `. , : ; # ( ) / _ ' -`, no leading space, no closing
keyword such as `closes #1`). `hands-update` reads `.harness/profile.json` from the project's
default branch before changing anything, with its own inline reader (so the lines work whatever kit
version the control repository pins), drops any line that fails with a warning in the run summary,
and appends the rest, each on its own line at column 1, to the update or rollback PR's body. If a
PR for that version is already open without them, it edits that PR's body, so the guard re-runs. The line is the project's standing
authorization: record the decision that grants it in the project, not in the kit.

## Kit update PRs keep themselves current

Under a strict required-checks rule a PR falls "behind" whenever its base branch moves, and GitHub's
auto-merge then waits forever. `hands-keep` (K012) brings every open kit update PR of the App's that
is behind up to date with GitHub's update-branch, through the App, so the project's checks run again
and auto-merge goes on; no session updates such a PR by hand. `hands-update` turns `hands-keep` on and
runs it once whenever it opens or finds a kit update PR; it then runs hourly and turns itself off
once none is open. A PR open longer than `HANDS_KEEP_HOURS` (the control repository's Actions
variable, default 72) is left to the stale-work check. Each update is a line in the hands log; a
refused update fails the run, one problem under the alert standard. A conflicted or draft PR is never
touched.

## GitHub-hosted minutes (O13)

GitHub bills a private repository's hosted-runner jobs, each rounded up to a whole minute. Public
repositories and self-hosted runners are not metered. Every kit workflow installed in a project
(`harness-*`) runs on `${{ vars.RUNNER || 'ubuntu-latest' }}`, the convention projects already use
for their own CI: with the project's Actions variable `RUNNER` set to a self-hosted runner's label,
these jobs use **no** GitHub-hosted minutes; without it they run on `ubuntu-latest` and cost what
the table says. Every such job stays safe on a self-hosted runner: the privileged ones check out
only the default branch's `.harness/tools`, never PR code, with `persist-credentials: false`, and
`harness-audit`, which runs a PR's own code, takes the self-hosted lane only for a PR from the same
repository (a fork's PR, or one whose fork was deleted, runs on `ubuntu-latest`). On a public
repository anyone can queue `harness-scrub` jobs on a self-hosted runner by posting comments, so a
public project may prefer to leave `RUNNER` unset for it; hosted minutes are free there. The control
repository's `hands-*` jobs stay on GitHub-hosted runners (the App key never moves to a general
worker, K008). Estimates per month without a self-hosted `RUNNER`, with N enrolled settings
repositories and K repositories that pin the kit:

| Workflow | Where | Trigger | Jobs per run | Estimate |
|---|---|---|---|---|
| `hands-settings` | control repo | daily drift check (which also ticks the alerts, posts the digest and alerts on any scheduled workflow here more than 36 h overdue); dispatch after a settings merge | 1, plus 2 when something drifts | ~30, plus ~3 per settings change |
| `hands-update` | control repo | weekly; dispatch | 2 + K | ~4.3 × (2 + K) |
| `hands-keep` | control repo | hourly, only while a kit update PR is open; dispatch | 1, plus 1 when it updates, fails or turns off | ~2-4 per kit update; at most ~75 for a PR left open 3 days |
| `hands-report` | control repo | called by the three above | (counted above) | 0 extra |
| `hands-alerts` | control repo | dispatch; hourly 08:00-22:00 Damascus only with `ALERTS_TICK=on` | 1 | ~1 per dispatch; ~450 with the tick on |
| `hands-check` | control repo | each PR push there | 1 | ~1 per PR push |
| `harness-audit` | each project | PR opened, pushed, reopened or edited; weekly | 1 | ~1 per PR event + 4 (a fork's PR always hosted) |
| `harness-inbox` | each project | an issue labelled `inbox` or reopened | 1, only for a queued request | ~1 per request; 0 with a self-hosted `RUNNER` |
| `harness-scrub` | each project | every issue, PR, comment and review posted or edited | 1 | ~1 per event: the largest cost on a busy private repo (~700+ events a month on one measured project); 0 with a self-hosted `RUNNER` |
| `harness-stale` | each project | daily; dispatch | 1 | ~30 (one short job a day); 0 with a self-hosted `RUNNER` |

Before 0.6.0, `hands-settings` ran hourly with one job per enrolled repository:
24 × 30 × (2 + N) minutes, which is 2,880 with N = 2 and 4,320 with N = 4.
