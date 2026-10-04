# Harness Kit · core

> Loaded in every session. Binds every agent in a project that installs the kit. Each line is a
> rule by ID; its applicability, expected outcome, source and check are in
> `.harness/catalogue/core.md` (lookup only, never preloaded). Project specifics live in the
> project profile and the project's own rulebook; where they are stricter, they win.

## Stages and the card

- **C01 Stages.** Work runs PLAN → BUILD → VERIFY → RELEASE → MAINTAIN. MAINTAIN may be not
  applicable. A small fix runs the compressed cycle: one card plans and builds it, its checks
  verify it, its merge releases it.
- **C02 One outcome per card.** A card states its stage, goal, context, numbered pass/fail
  acceptance, the files it may touch, done-when and blocked-by. Two outcomes are two ordered cards.
- **C03 How a card ends.** The final message opens `DONE —`, `WAITING FOR YOU — <exact action>` or
  `STOPPED — <why>`, then `Waiting for you:` · `Changed:` · `Found:` (`none` where empty); its
  last line repeats the status word.
- **C04 Never stall silently.** End a turn only when the card is DONE or STOPPED, nothing can move
  without the owner, or a watcher you started will wake you. A wait that can outlast the session
  leaves a durable handover (branch, PR, what is done, the exact next step), then ends.
- **C05 Investigate first.** List each card assumption the code or canon contradicts; one that
  changes the work is STOPPED. "No work needed" is a valid DONE, with why.
- **C06 Scope.** Touch only the files the card names; a high-risk path only when named. Unasked
  extras go to the closing note's NEXT, not the diff. No new dependency unless named.

## Evidence and verification

- **C07 Evidence.** A check counts only if it ran and exercised the change. A test's name, a skipped
  or not-run test, or a report without results is not evidence. Evidence holds for the current
  candidate; a relevant change voids what it affects.
- **C08 Tests are never weakened.** Each new behaviour has a check that fails without it. Never
  skip, isolate, weaken or delete a test to get green; fix the cause.
- **C09 Proportionate verification.** Risk tier sets the work: 1 (copy, comment, caller-less
  rename) builds; 2 (screens, components, non-privileged queries) investigates, builds, tests;
  3 (schema, migrations, auth, permissions, secrets, money math, config, CI, the harness, shared
  logic) maps the blast radius first and carries an authorization line naming its card. Unsure → 3.
- **C10 Independent review.** A tier-3 or profile-risky diff gets a fresh-context reviewer given
  only the diff and the rulebook: "List only problems you'd block the merge for: file, line, why,
  how to show it fails." Fix every block. Still blocked after 3 rounds → STOPPED; one extra focused
  round is allowed for a small final fix.
- **C11 Build floor and release bar.** A merge is blocked only by a broken essential workflow in
  the changed area, a security failure, data corruption or broken money math. Every other finding
  is logged with a severity; a release leaves VERIFY with no blocker or major open in its scope.

## Merge, release, failure

- **C12 Gates hold.** The default branch changes only by PR. Merge on the required checks green
  plus any required review with no block; never merge red. Gates and approvals are never worked
  around, relaxed or impersonated.
- **C13 After the merge.** Confirm the default-branch CI run for the merge commit, the deployment
  of that commit (matched by commit, not time) and live probes; record one ship line. A red
  default branch is the next card and admits only fix PRs.
- **C14 Failure handling.** A refused command or a safety refusal is a finding: report the exact
  command; never retry, reword or route around it. A missing repo, secret, connector or tool: name
  it and stop; never mock, substitute or guess. Three failures in a row on one step, or the turn
  budget, → STOPPED with what is complete. `Found:` names what went wrong, its class (context ·
  constraint · verification · planning) and where it is now prevented.
- **C15 No silent stall.** Green-but-unmerged PRs, conflicted PRs and quiet cards are listed on a
  schedule; each is resumed or reported STOPPED.

## Handover and canon

- **C16 Handover.** The closing note carries `RESULT · PR · CI · CHANGED · VERIFIED` (behaviour →
  the check that proved it, with its run link or output line) `· FINDINGS · NEXT`.
- **C17 One home per fact.** Point, never copy. Decisions are append-only: supersede, never edit.
  Volatile state lives only in the state file. Generated references are regenerated, never
  hand-edited. Always-loaded text is capped and must not grow.
- **C18 Ratchet.** A correction lands in its narrowest home first (the card, a module rule, a
  test) and becomes global only when it recurs. The owner's correction to how work runs is
  recorded as a decision the same day; chat is never the record.
- **C19 Prevention.** Every owner correction or repeated failure ends with its prevention, at the
  highest level worth its cost (the ladder is the `correct` skill). Escalate when an issue happens
  twice or is costly; a one-off small mistake is fixed, not ruled. Owner review is not a prevention
  level; independent AI review counts only for risky areas. Each prevention is recorded once, with
  where it lives; the audit reports corrections that recurred.
