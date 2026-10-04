# Harness Kit · capabilities

> Lookup only. A project enables capabilities in its profile (`capabilities`), directly or through
> a preset (`.harness/presets/`). A rule here binds only in a project that enables its capability;
> otherwise an audit marks it NOT APPLICABLE. Project specifics (which tables, which paths, which
> strings) live in the profile and the project's rulebook.

## database — the project owns a database schema

- **DB01 Migrations only.** Schema changes ship as migration files in the repo, through a PR; an
  applied migration is never edited; the database rebuilds from the repo (CI replays every
  migration on a throwaway database).
- **DB02 Consent class.** A migration that destroys or rewrites data or widens access needs the
  owner's own approval of that exact file (a hash or head commit), unless a recorded decision
  delegates it; a script, not a person, classifies the file. Applied ahead of a needed approval →
  STOPPED and reported, never repeated.
- **DB03 Backup first.** A verified backup (the dump reads back) precedes every apply; scheduled
  backups follow RJ01–RJ03.
- **DB04 Access control in the database.** Row-level access is on for every table and is the
  permission gate; a new table starts with no access and ships its policies in the same migration.
- **DB05 Generated schema reference.** After every apply the schema reference is regenerated, never
  hand-edited; agents grep it before asserting any object exists.

## auth — the project has sign-in, roles or permissions

- **AU01 Check by capability.** Permissions are checked by key, never by role name; roles and
  assignments are data; the last administrator can never be removed.
- **AU02 Server-side trust.** Privileged operations run on the server; client input is untrusted
  and validated at every write boundary.
- **AU03 Leading-site safety.** Sign-in, sign-up and recovery copy leading sites' safety: no account
  enumeration, resend cooldowns, scanner-safe links.
- **AU04 Deterministic permission tests.** Every grant or denial a diff adds has a deterministic
  test; auth and permission paths are tier 3.

## public interface — anonymous visitors reach the project

- **PI01 Nothing private in public output.** HTML, client bundles, API responses and build output
  carry no private field (prices, stock, customer data, tokens, session state) and no hidden
  record, enforced at build and request time, never by CSS or a client filter.
- **PI02 Measure compiled output.** A claim about what visitors receive cites the built artifact,
  not the source.
- **PI03 Public records stay clean.** Issues, PRs, served docs and logs carry no host detail,
  secret or personal data; an open defect is described by its shape, not its exploit.

## deployments — merges reach a running environment

- **DP01 Deploy from the default branch.** Production deploys only from the protected default
  branch; the ship check matches the deployment to the merge commit (C13).
- **DP02 Real data needs a verified release.** Once real users or data depend on production, it
  deploys only from a release that passed VERIFY.
- **DP03 Platform settings are owner-only.** Hosting, DNS and service dashboards change only by the
  owner or through a versioned, reviewed config in the repo.

## recurring jobs — the project runs scheduled or event-driven automation

- **RJ01 Bounded.** Every job has a timeout, bounded retries and a concurrency group.
- **RJ02 No silent failure.** Each job keeps one tracking issue, updated rather than duplicated,
  closed on the next success; after three failures in a row it says STOPPED with the cause and
  the job disables itself.
- **RJ03 Deduplicated alerts.** Alerts follow O10: one per incident, only when unresolved or action
  is required.
- **RJ04 Least privilege.** A job holding secrets or a privileged runner never checks out or runs
  code from an untrusted ref; permissions are declared per job.

## sensitive data — the project holds money, stock, personal or secret data

- **SD01 Money is integer.** Money is stored as integer minor units, never floats.
- **SD02 Computed, never guessed.** Money, stock and other derived figures are computed in SQL or
  server code, never in a component or by a model, covered by deterministic tests, and reconcile.
- **SD03 Secrets stay server-side.** Only variables explicitly marked public reach the browser;
  `.env*` files are never read, printed or committed by agents; names are verified, not values.

## bilingual — the project serves more than one language

- **BL01 Strings through i18n.** Every user-facing string goes through the i18n function, keyed in
  every language; each page has its mirror per language unless declared single-language.
- **BL02 Approved strings only.** Strings in a language the builder cannot judge ship only as the
  card approves them, listed in the PR; native review is batched and never blocks a merge.
- **BL03 Direction-safe styling.** Layout uses logical properties so right-to-left works without
  per-page overrides.

## host/infra — the project runs its own servers or runners

- **HI01 Versioned owner blocks.** A step the owner runs on a machine is a versioned, strict block
  proven first, one line for a fresh shell: `( set -e; … ); [ $? -eq 0 ] && echo OK || echo FAILED`.
- **HI02 No host details in the repo.** No hostname, IP, login or connection string in any
  committed file, issue, PR or comment.
- **HI03 Guarded runners.** Self-hosted runners admit only trusted refs and events; untrusted PR
  code never reaches a runner holding secrets.
- **HI04 Menu over shell.** Routine host maintenance runs through a guarded, versioned operations
  workflow, not ad-hoc commands.

## Records

| ID | Applies when | Expected outcome | Source | Verify |
|---|---|---|---|---|
| DB01 | capability database | No applied migration changed; CI replays all migrations from scratch. | ERP AGENTS §2 · D217, D240; WEB AGENTS §4 · W196 | script: diff check that existing migration files are unchanged; a replay job is required. |
| DB02 | capability database, a migration in the consent class | Each consent-class apply has the owner's approval on that file or a cited delegation. | ERP AGENTS §4 · D029, D258, D273; WEB AGENTS §4 · W196, W211 | script: a migration classifier runs in CI and blocks without approval. judgment: sampled applies match approvals. |
| DB03 | capability database | Every apply run shows a verified backup step before it. | ERP runbooks/backup; WEB db-backup, db-push workflows · W228 | script: the apply workflow has a backup-and-read-back step before apply. |
| DB04 | capability database with row-level security | Every table has access control on; new tables revoke default access in their migration. | ERP AGENTS §2 | script: catalog query lists tables without row security; grant audit. |
| DB05 | capability database | The reference matches a fresh generation. | ERP AGENTS §2, STRATEGIST · D259; WEB CLAUDE.md | script: CI drift check on the generated reference. |
| AU01 | capability auth | No permission check compares a role name. | ERP AGENTS §2 | script: grep for role-name comparisons in auth code. judgment: sampled permission diffs. |
| AU02 | capability auth | Every write boundary validates input server-side. | ERP AGENTS §2; WEB AGENTS §2 | judgment: sampled write endpoints validate input. |
| AU03 | capability auth with self-service accounts | No enumeration; cooldowns; links survive scanners. | WEB AGENTS §2 · W231, W234 | judgment: sampled auth flows against the list. |
| AU04 | capability auth | Grant and deny paths in a diff each have a test. | ERP run-card §4; WEB AGENTS §4 | judgment: sampled permission PRs name their tests. |
| PI01 | capability public interface | A leak scan of built output and API responses finds no private field or hidden record. | WEB AGENTS §2, §7 · W075, W077, W224 | script: build, then scan output for the profile's private field names and hidden-record ids. |
| PI02 | capability public interface | Claims about output cite built files. | WEB AGENTS §7 · W019, W020, W033 | judgment: sampled PR claims cite build output. |
| PI03 | capability public interface or public repo/docs | Public records hold no host, secret or personal detail. | ERP AGENTS §5 · D235; WEB AGENTS §5 · W150 | script: secret and host-pattern scan of issues and PR bodies. judgment: sample. |
| DP01 | capability deployments | Production deployments map to default-branch merge commits. | ERP skills/ship · D018; WEB skills/ship | script: compare the production deployment's commit with the default branch. |
| DP02 | capability deployments, real data in production | Production builds come only from verified releases. | ERP STRATEGIST §2 · D259 | judgment: sample production releases for VERIFY evidence. |
| DP03 | capability deployments | Platform setting changes trace to the owner or a reviewed config PR. | WEB AGENTS §6; ERP STRATEGIST §1 | judgment: sample platform audit logs where readable; else UNKNOWN. |
| RJ01 | capability recurring jobs | Every workflow job has `timeout-minutes`; scheduled jobs have a concurrency group; retries are capped. | K001 (H2 audit list); ERP and WEB workflows | script: parse workflows for timeout and concurrency on every job. |
| RJ02 | capability recurring jobs | Each scheduled job has one tracking issue mechanism and a stop-after-3 rule. | ERP box-watch, stale-work · D271; WEB db-backup · W236 | script: scheduled workflows reference a tracking-issue step. judgment: failures produced one issue each. |
| RJ03 | capability recurring jobs with alerts | Alerts dedupe and never report success. | K001; ERP infra alerts | judgment: sample alert history. |
| RJ04 | capability recurring jobs | Privileged jobs never check out untrusted refs; job permissions declared. | ERP main-red, stale-work workflows; WEB db-backup workflow · W199 | script: workflows with secrets on `pull_request_target`/`workflow_run` do not check out the head; `permissions:` set. |
| SD01 | capability sensitive data with money | Money columns are integer types. | ERP AGENTS §1 | script: schema reference scan for float money columns. |
| SD02 | capability sensitive data with derived figures | Derived figures come from SQL or server code with deterministic tests. | ERP AGENTS §1 · D005 | judgment: sampled money and stock diffs have deterministic tests. |
| SD03 | capability sensitive data | No secret in client bundles or public variables; agents denied `.env*` reads. | ERP AGENTS §5; WEB AGENTS §2, §5 · W079, W095 | script: scan built client output for secret patterns; settings deny `.env*` reads. |
| BL01 | capability bilingual | Every string key exists in every language; mirrors exist. | WEB AGENTS §2 · W023, W051, W056 | script: key parity check across languages; route mirror check. |
| BL02 | capability bilingual | Shipped strings in a judged language match the card's approved list. | WEB AGENTS §5, §7 · W125, W131 | judgment: sampled PRs list shipped strings against their card. |
| BL03 | capability bilingual with a right-to-left language | No physical left/right properties in new styles. | WEB AGENTS §2 | script: style lint for physical direction properties. |
| HI01 | capability host/infra | Owner run-blocks are versioned files in the repo and use the strict one-line shape. | ERP AGENTS §6 · D267; WEB AGENTS §8 · W230 | script: blocks in the repo match the shape. judgment: sampled owner batches. |
| HI02 | capability host/infra | No host details in tracked files, issues or PRs. | ERP AGENTS §5 · D235 | script: host-pattern scan of tracked files. |
| HI03 | capability host/infra with self-hosted runners | Runner guards admit only trusted refs. | ERP runbooks/automations · D269, D279; WEB db-backup workflow · W236 | judgment: read the runner guard; UNKNOWN if the host is unreadable. |
| HI04 | capability host/infra | Routine maintenance runs through the ops workflow. | ERP ops workflow · D267, D269 | judgment: sample recent host changes. |
