# Harness Kit · the hands App in operation

> Lookup only, never loaded by default. How settings as code runs day to day (A14, K007, K008), the
> emergency stop, and what each kit workflow costs in GitHub-hosted minutes (O13).

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

## GitHub-hosted minutes (O13)

GitHub bills a private repository's hosted-runner jobs, each rounded up to a whole minute. Public
repositories and self-hosted runners are not metered. Estimates per month, with N enrolled settings
repositories and K repositories that pin the kit:

| Workflow | Where | Trigger | Jobs per run | Estimate |
|---|---|---|---|---|
| `hands-settings` | control repo | daily drift check; dispatch after a settings merge | 1, plus 2 when something drifts | ~30, plus ~3 per settings change |
| `hands-update` | control repo | weekly; dispatch | 2 + K | ~4.3 × (2 + K) |
| `hands-report` | control repo | called by the two above | (counted above) | 0 extra |
| `hands-check` | control repo | each PR push there | 1 | ~1 per PR push |
| `harness-audit` | each project | PR opened, pushed, reopened or edited; weekly | 1 | ~1 per PR event + 4 |
| `harness-inbox` | each project | an issue labelled `inbox` or reopened | 1, only for a queued request | ~1 per request |
| `harness-scrub` | each project | every issue, PR, comment and review posted or edited | 1 | ~1 per event: the largest cost on a busy private repo |

Before 0.6.0, `hands-settings` ran hourly with one job per enrolled repository:
24 × 30 × (2 + N) minutes, which is 2,880 with N = 2 and 4,320 with N = 4.
