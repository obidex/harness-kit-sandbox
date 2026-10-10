# Adapter · Claude Code + GitHub

> Lookup only. How the kit reaches sessions on Claude Code (local and cloud threads) and is
> enforced on GitHub, plus the platform limits and lessons found so far. Platform lessons live
> here, never in core. When the platform changes, this file changes; core does not.

## Loading

- **A01 Entry files import the kit.** `CLAUDE.md` loads the kit with the supported `@path` import:
  `@.harness/core.md`, `@.harness/owner-defaults.md`, `@.harness/VERSION`, then the project's own
  rulebook (commonly `@AGENTS.md`, which other agents such as Codex also read). `CLAUDE.md` itself adds only
  Claude-specific mechanics. Loading is proven in a fresh session and again after a resume, by
  asking the session which kit version and which rule a given ID names.
- **A02 Lookup stays out of context.** The catalogue, capabilities, presets and this adapter are
  never imported; sessions read them on demand. Module rules that should load only when their files
  are touched go in `.claude/rules/*.md` with `paths:` frontmatter.
- **A03 Skills and subagents are project files.** Procedures live in
  `.claude/skills/<name>/SKILL.md` and load when named; review seats are subagents in
  `.claude/agents/` with read-only tools and a pinned model. The kit's own skills come from
  `.harness/templates/skills/<name>/` and are installed as `.claude/skills/<name>/` (kit-managed).
- **A04 No plugin delivery.** Cloud threads do not load plugins, so kit files are installed as a
  pinned copy in each project by `.harness/tools/harness.mjs`, listed with their hashes in
  `.harness/kit.lock.json`, and changed only by maintenance PRs (`hands-update`, A14).
- **A05 Settings are project-owned.** The kit does not manage `.claude/settings.json` (K001
  boundary). It records what projects keep there today: attribution turned off; deny `--admin`
  merges, force pushes, destructive git, `.env*` reads and edits to the settings file itself; a
  session never edits its own settings.
- **A15 Settings load only in a one-repository session.** A cloud thread applies a repository's
  `.claude/settings.json` (identity env, allow and deny rules, attribution) only while the session
  has exactly one repository. Attaching a second one (`add_repo`) takes effect at the next resume,
  and from then on the session runs without them: commits are authored as Claude and routine
  pushes and edits reach the auto-mode classifier. So a project thread never attaches a second
  repository: another repository's reads and writes go through the coordinator or the inbox (O14).
  Identity comes from those settings, or in a project with several repositories from `git config`
  in each clone before the first commit; a thread never re-authors a commit. Every project copies
  the standing approvals from `standing-approvals.md` into its instructions. A refused routine
  command is a settings fault: the coordinator fixes its cause (a fresh one-repository thread, or
  an allow rule the owner adds), never an owner sentence per push.

## Working in a session

- **A06 Wait on a watcher or a reminder.** After a push, start a background watcher that polls CI
  and prints one line (`PASSED`, `FAILED: <job>`, `STUCK`, `TIMEOUT`), then end the turn; the line
  wakes the session. A PR activity subscription is not a wait: a green check or a comment that lands
  mid-turn may never wake you. When no watcher covers the wait (a review, another thread, a run past
  the watcher's timeout), set one `send_later` self-reminder to this session at the expected finish;
  at most three per wait (C25), each recorded on the card (C22) and deleted at DONE (C23). Never wait
  by sleeping in conversation. A wait past the prompt-cache window (about an hour) leaves a C04
  handover and ends.
- **A07 Context budget.** Compact before about 200k tokens. Noisy steps (install, build, lint,
  test) write to a log file and print only exit code and summary; read the log only on failure.
- **A08 Push coherent changes.** Push once quick checks pass, not several unfinished pushes: each
  push cancels and restarts the PR's CI.
- **A09 Shell lessons.** Count with `grep -o … | wc -l`, not `grep -c`; under `pipefail` a trailing
  `grep -q` can invert the result; `( … ) && echo OK` ignores `set -e`, so use
  `( set -e; … ); [ $? -eq 0 ] && echo OK || echo FAILED`. Generators that read `git ls-files` see
  only tracked files: stage first.
- **A10 Merging from a cloud session.** `gh pr merge` may be unavailable (GraphQL blocked). Merge
  with the GitHub tool as a plain squash over REST, passing your own commit title and body (a
  default squash body adds a `Co-authored-by` trailer); never `--admin`. Bring a PR branch up to
  date on the server (the GitHub tool's update-branch, or `gh pr update-branch`, with the expected
  head SHA), never by pushing a local merge of main: that push carries other PRs' changes, agent
  rule files among them, and without settings it reaches the classifier (A15).
- **A16 Edit files with the file tools.** In a session without repository settings (A15), change
  files with the session's file-edit and write tools, never with a shell script (`python3 -`,
  `sed -i`, a heredoc into a file): shell edits of agent rule files go to the auto-mode classifier
  and are refused unpredictably; file-tool edits inside the working directory have not been. Seen in a
  several-repository project on 7-8 Oct 2026: nine refusals, every one a shell edit or a shell
  command after one; eleven file-tool edits of rule files in one thread, none refused. A refused
  shell edit is still reported (C14).

## GitHub enforcement

- **A11 One required check behind a ruleset.** The default branch sits behind a ruleset: PR only,
  squash only, no bypass actor, and one aggregate required check (for example `ci-ok`) that fails
  unless every job the change needs passed. CI failure lines start `INFRA:` or `TEST:`.
- **A12 Tier-3 guard.** A CI job lists changed paths matching the profile's tier-3 paths and
  fails unless the PR body has `Tier-3: authorized by card #<n>`; the workflow also triggers on
  `edited` so a body fix re-runs it.
- **A13 Unattended PRs need real identity.** Events caused by `GITHUB_TOKEN` do not start new
  workflow runs, and Actions may be barred from creating or approving PRs, so a maintenance PR that
  must run checks and auto-merge is opened by the owner's hands App (A14), whose tokens are minted
  per run and never expire. Auto-merge also needs the repository setting enabled and a required
  check to wait for, both of which the settings file declares. Under a strict check rule auto-merge
  never updates a branch that fell behind; the App does that for kit update PRs (`hands-keep`, K012).
- **A14 One App holds GitHub's hands.** The owner's single GitHub App is used only by reviewed
  workflows on the control repository's main branch (its key sits in an environment only `main`
  can use), never by an AI session. Each job mints a token for one repository and only the
  permissions it needs. Repository settings, rulesets with their required checks, auto-merge and
  labels are code: `.github/harness-settings.json`, checked on the PR, applied by a dispatch right
  after the merge and by a daily drift check, then read back (`hands.md`). Every write is logged
  in the control repository; a failure is one problem under the alert standard (O10, `alerts.md`).

## Records

| ID | Applies when | Expected outcome | Source | Verify |
|---|---|---|---|---|
| A01 | Claude Code is used | `CLAUDE.md` imports core, defaults and the rulebook; a fresh and a resumed session both answer the kit version correctly. | K001; ERP and WEB CLAUDE.md; PLATFORM (CLAUDE.md imports) | script: `CLAUDE.md` contains the three kit imports and their targets exist. judgment: `tools/probe-loading.sh` in a fresh session and after a resume. |
| A02 | Claude Code is used | No lookup file is imported; path rules carry `paths:`. | K001; ERP AGENTS §8, .claude/rules; PLATFORM | script: imports in `CLAUDE.md` exclude lookup files; each `.claude/rules/*.md` has `paths:`. |
| A03 | the project uses skills or subagents | Review subagents declare read-only tools and a model. | ERP .claude/agents · D282; WEB .claude/agents | script: agent files in review roles have `tools:` without write tools and a `model:`. |
| A04 | always | Kit files are present as a pinned copy with a recorded version. | K001 | script: `harness.mjs status`: `.harness/VERSION` matches the lock and every managed file matches its hash. |
| A05 | always | Settings are project-edited only; sessions cannot edit them. | K001; ERP settings · D289; WEB CLAUDE.md · W138 | script: settings deny edits to themselves and admin merges. judgment: settings changes came through owner or reviewed PR. |
| A06 | a session waits on CI or another event | Waits end the turn on a watcher or one `send_later` self-reminder at the expected finish (at most three per wait); no conversation polling; handovers for long waits; reminders deleted at DONE. | ERP run-card §7, wait-for script · D258; WEB run-card §7 · W221; K020 | script: a watcher script exists with a self-test. judgment: sampled threads ended waiting turns on a watcher or a reminder, and no reminder outlived its card. |
| A07 | long sessions or noisy commands | Sessions compact on time; noisy steps print summaries. | ERP CLAUDE.md, run-card §4 · D260; WEB run-card §4 | judgment: sampled transcripts show logged noisy steps. |
| A08 | a PR is open | No burst of unfinished pushes cancelled CI repeatedly. | ERP run-card §1 · D266 | judgment: sample push timelines on recent PRs. |
| A09 | shell scripts or commands are written | Scripts avoid the listed traps. | WEB run-card §10 · W097, W139; WEB AGENTS §8 · W230 | script: lint for `grep -c` in pipelines and `) && echo OK` patterns. |
| A10 | a cloud session merges or updates a PR branch | Squash commits on the default branch carry no Claude trailer; PR branches are updated on the server, not by a pushed local merge. | ERP · D290; K021 | script: scan recent default-branch commits for `Co-authored-by` trailers naming Claude. judgment: sampled PRs show server-side branch updates. |
| A11 | GitHub hosts the repo | The ruleset requires the aggregate check, PR only, squash only, no bypass. | ERP STRATEGIST §2 · D289; WEB AGENTS §6 · W100 | script: read rulesets via the API; UNKNOWN without admin read access. |
| A12 | the profile lists tier-3 paths | The guard runs on every PR including body edits. | ERP tier3-guard job; WEB tier3-guard step | script: workflow has the guard and the `edited` trigger. |
| A13 | an unattended PR must pass checks and merge | Maintenance PRs come from an App or owner-created token and their checks run. | K001 (H2); PLATFORM (GITHUB_TOKEN events do not trigger workflows) | script: the maintenance PR's author is the App or token identity and its check runs exist. |
| A14 | the kit is installed | Settings live in `.github/harness-settings.json` and the live repository matches it; only the hands App's reviewed workflows write them. | K007 (owner 4A) | script: the settings file is valid and the live repository matches it. |
| A15 | a cloud thread works in a project | Each thread runs with exactly one repository and its settings loaded (commits authored as the owner, no classifier refusal on routine work); a project with several repositories sets identity with `git config` per clone; every project's instructions carry the standing-approvals block of `standing-approvals.md`, at its current `kit text`; no commit is re-authored. | K021, K022 | script: commits on recent PR branches are authored as the owner. judgment: the project instructions' block matches the kit's, filled in; sampled refusals traced to a missing-settings session and fixed at the cause, never one owner sentence per push. |
| A16 | a session without repository settings changes files | Files change through the file-edit and write tools; no shell-script edit of a rule file. | K023 | judgment: sampled refusals in sessions without settings name no file-tool edit; a refused shell edit was reported and not retried. |
