# Standing approvals (the one source)

> Lookup only. The text every project copies into its own project instructions (the claude.ai
> project, not a repository file), so routine work never stops for an owner sentence. It mirrors
> existing rules and adds no gate: O09 (identity), C07 (checks), A10 and A15 (push and branch
> updates), C10, C12 and O11 (merge), O14 (talk). Source: K021, K022.

## How a project uses it

1. Copy the block below into the project instructions, replacing every `{{…}}` and keeping its
   `kit text` release as written (the release that last changed the block):
   - `{{DATE}}`: the day the owner approved this block for the project.
   - `{{PROJECT}}`: the project's name. `{{REPOS}}`: its repositories, `owner/name`, comma-separated.
   - `{{SETTINGS_LINE}}`: one of the two lines under "Settings line", by the number of repositories.
   - `{{OWNER_NAME}}`, `{{OWNER_EMAIL}}`: the identity commits are authored as (O09).
   - `{{INBOX_REPOS}}`: the repositories this project files inbox requests in (O14).
   - `{{RESERVED}}`: the owner's reserved list for this project (O01): at least spending money,
     going live in production, and any action the safety check refuses.
2. Change nothing else: the block is the same text in every project, so one kit release keeps them
   all in step. A project may only tighten it, through an exception in its profile naming a decision.
3. A release that changes the block sets its `kit text` to that release and says "standing
   approvals" in its changelog entry (`check-version` fails otherwise). The kit's maintainer
   sends each enrolled project one inbox request (O14) carrying its filled-in new block; that
   project's coordinator replaces its old block and closes the request with the date. A project
   whose block names an older `kit text` than this file is out of step.

## Settings line

- One repository: `Settings load from {{REPOS}}'s .claude/settings.json while a thread has this one repository (A15); these approvals hold as well, and a thread never attaches a second repository.`
- Several: `This project has several repositories, so no repository's settings load in its threads (A15); these approvals stand in for them.`

## The block

<!-- standing-approvals:begin -->
```
STANDING APPROVALS (kit text 0.20.0; owner, {{DATE}}; standing, for every {{PROJECT}} thread working an approved card)
{{SETTINGS_LINE}} The owner approves in advance:
- Identity: before the first commit, run `git config user.name {{OWNER_NAME}}` and `git config user.email {{OWNER_EMAIL}}` in each clone; commits and squash bodies carry no Claude attribution (O09). Never re-author a commit.
- Edits: change the files the card names in {{REPOS}}, including agent rule files (AGENTS.md, CLAUDE.md, .claude/rules, .claude/skills, the decisions log) and the project's shared agent memory, when the card is an owner-approved change to them. Kit-managed files change only through kit updates.
- Checks: run the repository's own checks and tests on the session's branch (its test and check scripts, linters and the kit's self-checks, as its CI runs them) before pushing; this is the real check C07 requires.
- Push: push the session's own claude/* branch (never the default branch, never a force push), open its PR, and bring the PR branch up to date on the server (A10); once, open the project's inbox-wake channel branch (O14).
- Merge: merge its own PR on green required checks plus the review its risk tier requires (C10, C12, O11). Never around a gate.
- Talk: comment on issues and PRs in {{REPOS}}; file and wake inbox issues in {{INBOX_REPOS}} (O14), through the coordinator when a thread holds one repository (A15).
Not covered (still the owner's): {{RESERVED}}; secrets, .claude/settings.json, root steps on machines, deleting data. A refused command is reported, never retried or reworded (C14).
```
<!-- standing-approvals:end -->
