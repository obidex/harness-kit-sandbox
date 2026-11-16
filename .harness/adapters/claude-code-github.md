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
  A Claude Projects cloud thread does not load project skills (A15): there a rule that names a
  skill (`correct`, `inbox`) means reading its `.claude/skills/<name>/SKILL.md` and following it.
- **A04 No plugin delivery.** Kit files are installed as a pinned copy in each project by
  `.harness/tools/harness.mjs`, listed with their hashes in `.harness/kit.lock.json`, and changed
  only by maintenance PRs (`hands-update`, A14). A plugin enabled on the account or in Project
  settings does load in cloud threads, hooks included (tested Nov 2026: a `prompt.submit` and a
  `tool.check` hook ran in a project thread), but a plugin is enabled by the owner, not by a
  repository, so the kit never depends on one.
- **A05 Settings are project-owned.** The kit does not manage `.claude/settings.json` (K001
  boundary). It records what projects keep there today: attribution turned off; deny `--admin`
  merges, force pushes, destructive git, `.env*` reads and edits to the settings file itself; a
  session never edits its own settings.
- **A15 Cloud threads load instructions, not settings.** A Claude Projects cloud thread loads
  `CLAUDE.md` with its imports and `.claude/rules/`, but not a repository's `.claude/settings.json`
  (identity env, allow and deny rules, attribution), hooks, skills or `.mcp.json`, whether the
  project has one repository or several (Claude Projects docs, Nov 2026; observed: a thread's
  `GIT_AUTHOR_NAME` unset and the project's skills absent). So: identity comes from `git config` in
  each clone before the first commit, from the project instructions; a thread never re-authors a
  commit. What must not be skipped is enforced where no session can skip it: rulesets, required
  checks and the hands App's workflows (the scrubber, `harness-guard`). A skill a rule names is read
  from its file (A03). Every project copies the standing approvals from `standing-approvals.md` into
  its instructions. A refused routine command is a settings fault: the coordinator fixes its cause
  (an allow rule the owner adds, or a plugin the owner enables), never an owner sentence per push.

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
- **A23 Name the model and the effort on every thread.** O06's roles, named as of Nov 2026: building
  on the smallest reliable model (Sonnet 5.5 for clear, bounded work); Opus 5.5 for architecture,
  accounting, security, hard or risky work, whatever the tier, and preferred for tier-3 review
  (C10, O07); Haiku 5.5 only for reading logs and summarizing when that saves real work, never for
  review or for money, stock or permission code. Plain status stays on existing checks, with no
  extra turn. Effort: low for a log digest, the default for building, high only for a tier-3 design or a review. The coordinator names
  both when it starts a thread; a thread never switches model mid-session. A long thread hands over
  (C04) and starts clean (`/clear`, or a fresh thread) rather than compacting a cold context. The
  coordinator reads `/usage` once a week and puts one line in the daily summary.
- **A24 The one-time permission line.** When a step on an approved, reviewed card is stopped by a
  safety check or permission prompt on the owner's own machine, or is one he would otherwise repeat by
  hand and a permission line would let an existing route do it, offer him the line once: first an
  existing route that needs nothing from him, then this, a manual step last. The offer is a decision
  with a recommendation: what was blocked and that nothing ran; the whole edit to the keystroke, with
  minutes; what the lines open, a wide one in its own plain sentence; "not tested until you do it, if it
  still refuses I report the exact text and stop". After he says done, read how the lines landed (a
  valid file, inside the list; read the permission list only, never the whole file, which can hold
  secrets) before using them, then report with proof. Only he edits permission
  settings; an agent never edits them and never asks him to switch a check off. A refusal still ends
  the attempt (C14): his own change to his own permissions, offered once, is the only thing that
  reopens it, never a reworded command, another tool or another session. No offer for spending, going
  live in production, deleting data without a verified backup, or secrets. The narrowest line that
  works: an exact command, or a script from a reviewed commit on the default branch, at a path the agent
  cannot write, whose arguments it does not execute (any other script line is wide); a wide one (`ssh <host>:*`) needs a named reason and a look-again
  date and is never given for a machine that holds real data. Each project keeps one list of the lines
  (line, what it opens, wide or narrow, card, date; no secrets), read first, additions asked in one
  batch. The how-to and the list's shape: `permission-line.md`.

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

## Supply chain (K030)

- **A17 New packages wait.** A dependency version is used only 3 to 7 days after its release:
  Dependabot's `cooldown` on every ecosystem it updates, `min-release-age=3` in `.npmrc` (npm 11 or
  later), and CI installs from the lockfile with `npm ci`, never `npm install`.
- **A18 Actions pinned by commit.** Every action a workflow uses names a full commit SHA, its version
  in a comment, or the repository's `.github/workflows/actions.lock` pins it and CI runs
  `gh actions-lock --verify`. Dependabot moves the pins.
- **A19 Least-privilege workflows.** No `pull_request_target` trigger. The workflow-level
  `permissions` is read-only, and a job asks only for the writes it needs. A public repository runs
  no job on a self-hosted runner. A self-hosted runner runs one job at a time and holds no
  production secret.
- **A20 A secret scan on every PR.** `harness-guard` scans each PR's commits with a pinned,
  checksummed gitleaks and is a required check. A public repository also turns on GitHub's free
  secret scanning and push protection in its settings file.
- **A21 Agent configuration from trusted accounts.** A PR that changes what agents load or run
  (`CLAUDE.md`, `AGENTS.md`, `.claude/**`, `.harness/**`, `.mcp.json`, plugin code, git hooks) or
  `.github/**` passes `harness-guard` only when its author and every commit come from the profile's
  `trusted_actors`, by numeric ID, read from the base branch. The workflow file runs from the PR, so
  a session never merges a PR from an untrusted account that touches `.github/workflows/`, and merges
  Dependabot's only when its workflow diff changes nothing but action pins.
- **A22 Limits that expire are renewed.** A repository that limits who may comment or open issues
  and PRs declares it in its settings file; the daily drift check applies it again before GitHub
  lets it lapse (six months at most).

## Records

| ID | Applies when | Expected outcome | Source | Verify |
|---|---|---|---|---|
| A01 | Claude Code is used | `CLAUDE.md` imports core, defaults and the rulebook; a fresh and a resumed session both answer the kit version correctly. | K001; ERP and WEB CLAUDE.md; PLATFORM (CLAUDE.md imports) | script: `CLAUDE.md` contains the three kit imports and their targets exist, and imports `AGENTS.md` when there is one. judgment: `tools/probe-loading.sh` in a fresh session and after a resume. |
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
| A15 | a cloud thread works in a project | Each thread sets identity with `git config` per clone (commits authored as the owner); what must not be skipped is enforced by rulesets and required checks, not by repository settings a cloud thread never loads; every project's instructions carry the standing-approvals block of `standing-approvals.md`, at its current `kit text`; no commit is re-authored. | K021, K022, K031 | script: commits on recent PR branches are authored as the owner. judgment: the project instructions' block matches the kit's, filled in; sampled refusals traced to a missing-settings session and fixed at the cause, never one owner sentence per push. |
| A16 | a session without repository settings changes files | Files change through the file-edit and write tools; no shell-script edit of a rule file. | K023 | judgment: sampled refusals in sessions without settings name no file-tool edit; a refused shell edit was reported and not retried. |
| A17 | the project installs packages | Dependabot waits at least 3 days on every ecosystem; npm projects set `min-release-age`; CI runs `npm ci`. | K030 (radar, roadmap #48 P2: ChainDrop, Aug 2026) | script: `.github/dependabot.yml` gives every update a `cooldown` with `default-days` of 3 to 7; with a `package.json`, `.npmrc` sets `min-release-age` of 3 or more and no workflow runs `npm install`. |
| A18 | the project has workflows | Every remote action is pinned to a full commit SHA, or by a verified `actions.lock`. | K030 | script: every `uses:` naming a remote action ends in a 40-character SHA, or `actions.lock` exists and a workflow runs `gh actions-lock --verify`. |
| A19 | the project has workflows | No `pull_request_target`; workflow-level permissions read-only; no self-hosted runner on a public repository; one job per runner and no production secret on it. | K030 | script: no workflow triggers on `pull_request_target`; the top-level `permissions` grants no write; on a public repository (read through the API) no job names a self-hosted runner and the `RUNNER` variable is not set. judgment: runner hosts run one job at a time and hold no production secret. |
| A20 | the project has pull requests | `harness-guard` runs gitleaks on every PR and is required; a public repository's settings file turns on secret scanning and push protection. | K030 | script: `harness-guard.yml` is installed and the default branch's ruleset requires `harness-guard`; on a public repository the settings file enables both secret protections. |
| A21 | agents work in the project | Agent-configuration changes pass only from trusted account IDs. | K030 | script: the profile names `trusted_actors` and `harness-guard.yml` is installed. judgment: sampled PRs that changed agent configuration or `.github/workflows/` came from those accounts; no untrusted PR touching `.github/workflows/` was merged on a green guard. |
| A22 | GitHub hosts a public repo | The limit is declared and renewed before it lapses. | K030 | script: when the live repository has an interaction limit (read through the API), the settings file declares `interaction_limits`. |
| A23 | a coordinator starts threads | Each thread runs on the model and effort its risk calls for, named at its start and never switched; long threads hand over instead of compacting cold; `/usage` is read weekly. | K032; O06 | judgment: sampled threads' first messages name model and effort matching their work and risk; the daily summaries carry a weekly usage line. |
| A24 | a step on an approved card is stopped by a safety check or prompt on the owner's own machine, or a permission line would spare him a repeated manual step | The owner got one offer in the six-part shape (decision, whole edit with minutes, what the lines open, untested warning, read-back after done, result with proof) after existing routes and before any manual step; he alone edited the permission file; a refusal was never retried, reworded or routed around; no offer touched his reserved list; the lines are narrow or carry a reason and date; the project's list names each line, what it opens, its card and date. | K045 (owner, 11 Nov 2026: roadmap #101, from a runner-setup thread); C14; O17 | judgment: sampled stops on the owner's machine ended in the offer, not a workaround or a manual step; the list matches the owner's file as he reported it; no wide line covers a machine with real data. |
