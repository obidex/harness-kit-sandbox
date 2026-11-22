# .harness — the kit's shared content

Installed in each project as a pinned copy (K001). Layers, not systems:

| Layer | File | Loaded? |
|---|---|---|
| Core: stages, lifecycle, evidence, scope, handovers, failure, verification | `core.md` | Every session (`@` import in `CLAUDE.md`) |
| Owner defaults: how agents work with the owner | `owner-defaults.md` | Every session |
| Project profile: stack, commands, branches, checks, environments, modules, rules, permissions, capabilities, exceptions | `profile.json` (project-owned), shape in `profile.schema.json` | Read on demand |
| Capabilities: rules per capability | `capabilities.md` | Lookup |
| Presets: named sets of capabilities | `presets/web-app.md`, `presets/public-website.md` | Lookup |
| Platform adapter: Claude Code + GitHub loading, limits, lessons | `adapters/claude-code-github.md` | Lookup |
| Rule catalogue: applies when, outcome, source, verification per ID | `catalogue/` | Lookup |
| Rules left to projects, and conflicts | `project-specific.md` | Lookup |
| The hands App in operation: when settings apply, the emergency stop, minutes per workflow | `hands.md` | Lookup |
| Models and effort: which model and effort each kind of run uses, and Anthropic's effort advice (B0, B3 of K049) | `models.md` | Lookup |
| Clean-up card: the pilot template that may change patterns on purpose (C26's exception, K049) | `cards/cleanup.md` | Lookup |
| Bulk work: every ready card at once, the two reasons to wait, subagents, the owner's browser, scarce resources, one report at the end; an agent on a server (C20, HI05, K051) | `bulk.md` | Lookup |
| Owner steps (K058): designed away at the plan ("No-one designs"), the ladder, the three stops, secrets carried only when no design fits, the `Tried:` line on every step that reaches him, helper tasks on Haiku (O01, O02, O04, O06, O17) | `owner-steps.md`, `tools/owner-step.mjs` | Lookup; tool run, never loaded |
| Decisions, one file each: the closed log, `decisions/<ID>.md`, what two threads do with one number, the check (C17, K052) | `decisions.md`, `tools/decisions.mjs` | Lookup; tool run, never loaded |
| Standing approvals: the one text every project copies into its project instructions, with its fill-ins and how it stays in step | `standing-approvals.md` | Lookup |
| One-time permission line: how a thread offers the owner one permission line so a blocked step stops coming back to him, and the shape of a project's list of lines (A24) | `permission-line.md` | Lookup |
| Cross-project requests: the issue shape, pickup wiring, setup, cost | `inbox.md`, `tools/inbox.mjs`, `templates/workflows/harness-inbox.yml` | Lookup |
| Alerts: the one Telegram group, its rules, each sender's wiring, cost (O10) | `alerts.md`, `tools/notify.mjs` | Lookup |
| Control panel: the channel-free core, its buttons, /status, decisions, the log; adapters: file, Telegram (K025) | `tools/panel.mjs` | Run, never loaded |
| Questions for the owner on a card, answered with a panel button and written back by the hands App (K026) | `tools/ask.mjs`, `templates/hands/hands-answer.yml` | Run, never loaded |
| Explain this failure: a panel press posted for the coordinator by the hands App, answered by a Claude session (K027, K028) | `tools/explain.mjs`, `templates/hands/hands-explain.yml` | Run, never loaded |
| Disposable, event-fired coordinators (K033): the `wake` label starts one fresh run through the project's scheduled task, one at a time, capped, with a daily backstop that stops when idle. K056: a session that hands work to another project starts that project's run itself, under the same decision (`wake.mjs handoff`). K057: the job may start the run by its claim label alone (`WAKE_START=label`) | `wake.md`, `tools/wake.mjs`, `templates/workflows/harness-wake.yml` | Lookup |
| Stale work (C15): one daily tracking issue "Stale work"; thresholds in hours as data (profile `stale`, K035), a board's initiatives and wait records too; each stale item a row on the Ops board (`ALERTS_OPS_BOARD`), ✅ when it moves; a STATE issue out of date while work merged (one row, K042); missed scheduled runs (36 h overdue) | `tools/stale.mjs`, `templates/workflows/harness-stale.yml` | Run, never loaded |
| Second review (K054, K055, K060): once a pull request's checks are green, a model lists what it would block the merge for in one advisory comment (O07); no key (identity federation), capped per day; off by default, on only until the end time the owner's command names (`until` in `.github/harness-review.json`, the project's own settings file). A full check of existing code, started by hand inside that window, files graded findings as issues | `review.md`, `tools/review.mjs`, `tools/sweep.mjs`, `templates/workflows/harness-review.yml`, `templates/workflows/harness-sweep.yml` | Lookup; tools run, never loaded |
| Action groups (K035): every workflow names `auto` or `approval`; `human` (payments, spending, design picks) is never automated | `tools/actions.mjs` | Run, never loaded |
| Supply-chain floor (K030): `harness-guard`, a required PR check that runs gitleaks on the PR's commits and lets only the profile's `trusted_actors` change agent configuration | `tools/guard.mjs`, `templates/workflows/harness-guard.yml`; rules A17-A22 | Run, never loaded |
| Measuring the agents (K034): GitHub numbers for the health page, the always-loaded token budget (audit C17), the replay set for rule and model changes | `metrics.md`, `tools/metrics.mjs`, `tools/load.mjs` | Lookup; tools run, never loaded |
| Audit: structural script and judgment review | `tools/audit.mjs`, `audit/README.md` | Run, never loaded |
| Installer and updater | `tools/harness.mjs`, workflows from `templates/workflows/` (each on the project's `RUNNER` lane, `hands.md`; the profile's chore lane written in, K063) | Run, never loaded |
| CI speed (K059, K063): a chore lane (the profile's `chore_runner`, the variable `CHORE_RUNNER` overriding it) for the kit's short jobs, one scrub run per burst, a project's own checks scaled to the change with a nightly full run, the long test job split | `ci.md`, `tools/scope.mjs` | Lookup; tool run, never loaded |
| Kit skills: `correct` (C19 prevention ladder), `inbox` (O14 requests) | `templates/skills/<name>/`, installed as `.claude/skills/<name>/` | Loaded when named |

`VERSION` is the kit version a project pins (imported by `CLAUDE.md`); cards record it. In a project,
`kit.lock.json` lists every kit-managed file with its hash; `profile.json` is the project's own.

Install in a project (from its root): `node <kit checkout>/.harness/tools/harness.mjs init --version
X.Y.Z --preset web-app`, then fill `.harness/profile.json` and add `.github/harness-settings.json`
(`node .harness/tools/hands.mjs export --repo owner/name` writes today's settings). The owner's hands
App (A14) then applies those settings and keeps the kit current from the control repository; the
templates for it are `templates/hands/`. Only presets in use are built;
others are defined when a real project needs them, by what makes them different (K001).
