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

## Working in a session

- **A06 Wait on a watcher.** After a push, start a background watcher that polls CI and prints one
  line (`PASSED`, `FAILED: <job>`, `STUCK`, `TIMEOUT`), then end the turn; the line wakes the
  session. Never wait by sleeping in conversation. Backup: one check an hour, at most three per
  task. A wait past the prompt-cache window (about an hour) leaves a C04 handover and ends.
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
  default squash body adds a `Co-authored-by` trailer); never `--admin`.

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
  check to wait for, both of which the settings file declares.
- **A14 One App holds GitHub's hands.** The owner's single GitHub App is used only by reviewed
  workflows on the control repository's main branch (its key sits in an environment only `main`
  can use), never by an AI session. Each job mints a token for one repository and only the
  permissions it needs. Repository settings, rulesets with their required checks, auto-merge and
  labels are code: `.github/harness-settings.json`, checked on the PR, applied by a dispatch right
  after the merge and by a daily drift check, then read back (`hands.md`). Every write is logged
  in the control repository; a failure alerts once by Telegram (O10).

## Records

| ID | Applies when | Expected outcome | Source | Verify |
|---|---|---|---|---|
| A01 | Claude Code is used | `CLAUDE.md` imports core, defaults and the rulebook; a fresh and a resumed session both answer the kit version correctly. | K001; ERP and WEB CLAUDE.md; PLATFORM (CLAUDE.md imports) | script: `CLAUDE.md` contains the three kit imports and their targets exist. judgment: `tools/probe-loading.sh` in a fresh session and after a resume. |
| A02 | Claude Code is used | No lookup file is imported; path rules carry `paths:`. | K001; ERP AGENTS §8, .claude/rules; PLATFORM | script: imports in `CLAUDE.md` exclude lookup files; each `.claude/rules/*.md` has `paths:`. |
| A03 | the project uses skills or subagents | Review subagents declare read-only tools and a model. | ERP .claude/agents · D282; WEB .claude/agents | script: agent files in review roles have `tools:` without write tools and a `model:`. |
| A04 | always | Kit files are present as a pinned copy with a recorded version. | K001 | script: `harness.mjs status`: `.harness/VERSION` matches the lock and every managed file matches its hash. |
| A05 | always | Settings are project-edited only; sessions cannot edit them. | K001; ERP settings · D289; WEB CLAUDE.md · W138 | script: settings deny edits to themselves and admin merges. judgment: settings changes came through owner or reviewed PR. |
| A06 | a session waits on CI or another event | Waits use a watcher; no conversation polling; handovers for long waits. | ERP run-card §7, wait-for script · D258; WEB run-card §7 · W221 | script: a watcher script exists with a self-test. judgment: sampled threads ended turns on a watcher. |
| A07 | long sessions or noisy commands | Sessions compact on time; noisy steps print summaries. | ERP CLAUDE.md, run-card §4 · D260; WEB run-card §4 | judgment: sampled transcripts show logged noisy steps. |
| A08 | a PR is open | No burst of unfinished pushes cancelled CI repeatedly. | ERP run-card §1 · D266 | judgment: sample push timelines on recent PRs. |
| A09 | shell scripts or commands are written | Scripts avoid the listed traps. | WEB run-card §10 · W097, W139; WEB AGENTS §8 · W230 | script: lint for `grep -c` in pipelines and `) && echo OK` patterns. |
| A10 | a cloud session merges | Squash commits on the default branch carry no Claude trailer. | ERP · D290 | script: scan recent default-branch commits for `Co-authored-by` trailers naming Claude. |
| A11 | GitHub hosts the repo | The ruleset requires the aggregate check, PR only, squash only, no bypass. | ERP STRATEGIST §2 · D289; WEB AGENTS §6 · W100 | script: read rulesets via the API; UNKNOWN without admin read access. |
| A12 | the profile lists tier-3 paths | The guard runs on every PR including body edits. | ERP tier3-guard job; WEB tier3-guard step | script: workflow has the guard and the `edited` trigger. |
| A13 | an unattended PR must pass checks and merge | Maintenance PRs come from an App or owner-created token and their checks run. | K001 (H2); PLATFORM (GITHUB_TOKEN events do not trigger workflows) | script: the maintenance PR's author is the App or token identity and its check runs exist. |
| A14 | the kit is installed | Settings live in `.github/harness-settings.json` and the live repository matches it; only the hands App's reviewed workflows write them. | K007 (owner 4A) | script: the settings file is valid and the live repository matches it. |
