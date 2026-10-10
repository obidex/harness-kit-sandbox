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
| Standing approvals: the one text every project copies into its project instructions, with its fill-ins and how it stays in step | `standing-approvals.md` | Lookup |
| Cross-project requests: the issue shape, pickup wiring, setup, cost | `inbox.md`, `tools/inbox.mjs`, `templates/workflows/harness-inbox.yml` | Lookup |
| Alerts: the one Telegram group, its rules, each sender's wiring, cost (O10) | `alerts.md`, `tools/notify.mjs` | Lookup |
| Control panel: the channel-free core, its buttons, /status, decisions, the log; adapters: file, Telegram (K025) | `tools/panel.mjs` | Run, never loaded |
| Questions for the owner on a card, answered with a panel button and written back by the hands App (K026) | `tools/ask.mjs`, `templates/hands/hands-answer.yml` | Run, never loaded |
| Stale work (C15): one daily tracking issue "Stale work"; missed scheduled runs (36 h overdue); alerts through `notify.mjs` | `tools/stale.mjs`, `templates/workflows/harness-stale.yml` | Run, never loaded |
| Audit: structural script and judgment review | `tools/audit.mjs`, `audit/README.md` | Run, never loaded |
| Installer and updater | `tools/harness.mjs`, workflows from `templates/workflows/` (each on the project's `RUNNER` lane, `hands.md`) | Run, never loaded |
| Kit skills: `correct` (C19 prevention ladder), `inbox` (O14 requests) | `templates/skills/<name>/`, installed as `.claude/skills/<name>/` | Loaded when named |

`VERSION` is the kit version a project pins (imported by `CLAUDE.md`); cards record it. In a project,
`kit.lock.json` lists every kit-managed file with its hash; `profile.json` is the project's own.

Install in a project (from its root): `node <kit checkout>/.harness/tools/harness.mjs init --version
X.Y.Z --preset web-app`, then fill `.harness/profile.json` and add `.github/harness-settings.json`
(`node .harness/tools/hands.mjs export --repo owner/name` writes today's settings). The owner's hands
App (A14) then applies those settings and keeps the kit current from the control repository; the
templates for it are `templates/hands/`. Only presets in use are built;
others are defined when a real project needs them, by what makes them different (K001).
