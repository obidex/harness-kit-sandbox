# Rules deliberately left project-specific

> What H1 found in the two first projects' harnesses and chose NOT to put in the kit, each with
> why. They stay in each project's own rulebook, profile or decisions. Described by kind only:
> no business data or private text is copied here. `ERP` = the web app, `WEB` = the public website.
> A rule moves into the kit only by a new `DECISIONS.md` entry, typically when a second project
> needs it (C18).

## Left in the project

| ID | Rule (by kind) | Where | Why it stays project-specific |
|---|---|---|---|
| L01 | The currency model and its one documented exception (rate source, business-day time zone) | ERP AGENTS §1 · D252, D253 | Business rule of one company. The kit keeps only the generic SD01/SD02. |
| L02 | Readers without a cost permission see cost elements absent, never disabled | ERP AGENTS §3 | A product decision for one app's UI. Candidate capability rule if a second app needs it. |
| L03 | The design-approval protocol details (session phrases, number of options, artboard handling) | ERP STRATEGIST §2 · D248, D251, D253 | The owner's design ritual varies by product; the kit keeps WA01's outcome only. |
| L04 | The migration approval mechanism: SQL and hash on the card plus a reaction, vs the owner's review on the head commit | ERP AGENTS §4 · D257, D258, D285; WEB AGENTS §4 · W196, W211 | Two working mechanisms bound to each project's CI; the kit fixes the outcome (DB02), not the mechanism. See X01. |
| L05 | The example-data delegation of migration consent | ERP · D264, D273 | Tied to one database's data-status marker and launch plan. |
| L06 | Tier-3 path lists | ERP AGENTS §4, tier3-guard; WEB AGENTS §4 | Per codebase. Carried by the profile's `risk.tier3_paths`. |
| L07 | Domain review seats (bypass, compliance, test validity, Postgres semantics) and their prompts | ERP .claude/agents · D282 | Lenses written for one schema and permission model. The kit keeps C10's fresh-context review. |
| L08 | The public site's blocking list (what counts as a leak, unapproved language strings, broken build) | WEB AGENTS §7, milestone-review §2 | Its items are that site's private fields. Generic shape lives in PI01, BL02, C11. |
| L09 | Content-store data contract (query options, field shapes, image sizes, never-touch files) | WEB AGENTS §3 | Stack and schema facts. |
| L10 | Stack rules (static framework, vanilla CSS and JS, no host-specific APIs, TypeScript boundaries) | WEB AGENTS §2 · W003, W004, W074, W078, W086 | Technology choices of one project. PW01 keeps the generic static-by-default rule. |
| L11 | Language policy: single-language left-to-right vs two languages with right-to-left | ERP SPEC §6.0 · D242; WEB AGENTS §2 · W023 | Enabled by the profile (`bilingual`), not a kit rule. |
| L12 | Canon file names, decision prefixes and formats (one-line vs two-line entries), byte-cap numbers | ERP canon-lint · D243, D291; WEB CLAUDE.md | Each project's canon grew differently; the kit requires caps and append-only (C17) and reads numbers from `canon.caps`. |
| L13 | Which external reviewers run, on what, and their budget | ERP · D263, D280, D283, D287; WEB AGENTS §7 | Vendor and cost choices change often; O07 keeps them advisory. |
| L14 | Self-hosted runner lanes, fallbacks and the ops menu's operations | ERP runbooks/automations · D269, D279; WEB db workflows · W199, W236 | Infrastructure of one setup. HI01–HI04 keep the generic outcomes. |
| L15 | The coordinator's per-card status message (progress bar, pace estimate, check cadence) | ERP STRATEGIST §1; WEB skills/coordinate | Identical in both, but it is coordinator display, not a thread rule. Candidate to promote to owner defaults in H5. |
| L16 | Dependency-bot handling | ERP run-card §7; WEB AGENTS §6 · W114, W123 | The two projects differ (see X04); left local until the owner picks one. |
| L17 | Thread capacity (threads at once, threads sharing a layout) | ERP STRATEGIST §1 · D256; WEB AGENTS §8 | Capacity depends on the project's CI and shared files. |
| L18 | The owner's personal context and vocabulary table | ERP STRATEGIST §5 | Personal data: never in this public repo. |
| L19 | Service identifiers (hosting project and team ids, content project ids, live URLs) | ERP STRATEGIST §1; WEB AGENTS §1 | Private identifiers: never in this public repo; the profile names services by kind. |
| L20 | Release and launch plans, roadmaps, finding counts | ERP STATE, ROADMAP; WEB STATE | Volatile project state. |
| L21 | Hook scripts (command refusal, post-edit type-check) and their settings wiring | WEB CLAUDE.md, scripts/dispatch · W107, W115, W138 | Need `.claude/settings.json`, outside the kit (K001, A05). Candidate if that boundary moves. |

## Conflicts between the two projects, flagged for judgment

| ID | Topic | ERP | WEB | Kit position |
|---|---|---|---|---|
| X01 | Migration approval act | A reaction on a hash-carrying comment | The owner's own review on the head commit | Both satisfy DB02. Owner to pick one in H3/H4, or keep both as local mechanisms. |
| X02 | Thread model | Sonnet or Opus by task (D275) | Opus for every thread (run-card §1) | O06 (owner default) says by task; WEB departs and should align or record an exception. |
| X03 | Review scope | Reviewer on tier 3, money, stock, permission diffs (D282) | Reviewer on every code diff (run-card §5) | Both fit C10; WEB's is a tightening, recorded as a profile exception. |
| X04 | Dependency-bot PRs | Merged as a named rider when grouped minor/patch and green | Never merged; the update is applied in a card's PR | No kit rule yet. Owner decision when a project enrolls. |
| X05 | Requesting the owner's review on PRs | Not addressed | Forbidden (run-card §6) | The cloud platform auto-requests the requester's review on PRs it opens. O11 says the owner is never a merge gate; requesting review for visibility does not make him one. Needs an owner call if he wants no review requests. |
| X06 | Owner steps per message | "a few", in one batch | At most 3 per message (W230) | O02 says "a few"; WEB's 3 is a tightening. |
