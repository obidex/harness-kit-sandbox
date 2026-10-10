# Harness Kit · core

> Loaded every session; binds every agent. Records: `.harness/catalogue/core.md` (lookup only).
> The profile and rulebook win where stricter.

## The card

- **C01 Stages.** PLAN → BUILD → VERIFY → RELEASE → MAINTAIN (may not apply). A small fix is
  one card: it plans and builds, its checks verify, its merge releases.
- **C02 One outcome per card.** A card states its stage, goal, context, numbered pass/fail
  acceptance, the files it may touch, done-when and blocked-by. Two outcomes are two ordered cards.
- **C03 How a card ends.** The final message opens `DONE —`, `WAITING FOR YOU — <exact action>`
  (the owner acts next), `WAITING ON <who> — <what>` naming its wake (C22), or
  `STOPPED — <why>`; then `Waiting for you:` · `Changed:` · `Found:` (`none` where empty); its last
  line repeats the status word. "Nothing" is never a status while any party has an action.
- **C04 Never stall silently.** End a turn only when the card is DONE or STOPPED, nothing can move
  without the owner, or a wake you set will come (C25). A wait that can outlast the session leaves
  a durable handover (branch, PR, done work, exact next step), then ends.
- **C05 Investigate first.** List each card assumption the code or canon contradicts; one that
  changes the work is STOPPED. "No work needed" is a valid DONE, with why.
- **C06 Scope.** Touch only the files the card names; a high-risk path only when named. Unasked
  extras go to NEXT, not the diff. No new dependency unless named.

## Evidence

- **C07 Evidence.** A check counts only if it ran and exercised the change. A test's name, a skipped
  test or a report without results is not evidence. Evidence holds for the current candidate; a
  relevant change voids what it affects.
- **C08 Tests are never weakened.** Each new behaviour has a check that fails without it. Never
  skip, isolate, weaken or delete a test to get green; fix the cause.
- **C09 Proportionate verification.** Risk tier sets the work: 1 (copy, comment, caller-less
  rename) builds; 2 (screens, components, non-privileged queries) investigates, builds, tests;
  3 (schema, migrations, auth, permissions, secrets, money math, config, CI, the harness, shared
  logic) maps the blast radius first and carries an authorization line naming its card. Unsure → 3.
- **C10 Independent review.** A tier-3 or profile-risky diff gets a fresh-context reviewer given
  only the diff and the rulebook: "List only problems you'd block the merge for: file, line, why,
  how to show it fails." Fix every block. Blocked after 3 rounds → STOPPED (one more may close
  a small final fix).
- **C11 Build floor and release bar.** A merge is blocked only by a broken essential workflow in
  the changed area, a security failure, data corruption or broken money math. Every other finding
  is logged with a severity; a release leaves VERIFY with no blocker or major open in its scope.

## Merge and failure

- **C12 Gates hold.** The default branch changes only by PR. Merge on required checks green
  plus any required review with no block; never merge red. Gates and approvals are never worked
  around, relaxed or impersonated.
- **C13 After the merge.** Confirm the default-branch CI run for the merge commit, its deployment
  (matched by commit, not time) and live probes; record one ship line. A red default branch is the
  next card and admits only fix PRs.
- **C14 Failure handling.** A refused command or safety refusal is a finding: report the exact
  command; never retry, reword or route around it. A missing repo, secret, connector or tool: name
  it and stop; never mock, substitute or guess. Three failures in a row on one step, or the turn
  budget → STOPPED with what is complete. `Found:` names what went wrong, its class (context ·
  constraint · verification · planning) and where it is now prevented.
- **C15 No silent stall.** Green unmerged PRs, conflicted PRs and quiet cards are listed on a
  schedule; each resumes or is STOPPED.

## Canon

- **C16 Handover.** The closing note carries `RESULT · PR · CI · CHANGED · VERIFIED` (behaviour →
  the check that proved it, with run link or output) `· FINDINGS · NEXT`.
- **C17 One home per fact.** Point, never copy. Decisions are append-only: supersede, never edit.
  Volatile state lives only in the state file. Generated references are regenerated, never
  hand-edited. Always-loaded text is capped and must not grow.
- **C18 Ratchet.** A correction lands in its narrowest home (the card, a module rule, a
  test) and goes global only when it recurs. The owner's correction to how work runs is
  recorded as a decision the same day; chat is never the record.
- **C19 Prevention.** Every owner correction or repeated failure ends with its prevention, at the
  highest level worth its cost (the `correct` skill). Escalate on a repeat or costly issue; a
  one-off small mistake is fixed, not ruled. Owner review is no prevention; independent AI review
  counts only for risky areas. Each prevention is recorded once, with where it lives.

## Finishing and waiting

Assigned work always finishes on its own; automations never run forever.

- **C20 Finish line.** A coordinator finishes the approved initiative or batch with its fixes,
  reviews, merges and dependent cards; no improvement rounds after it. Next items start by board
  order when a slot opens; owner-ready, Ideas and Later items wait.
- **C21 Full handoff.** A CI result is read (C25) → check the current commit and its required
  review (re-review after later commits) → clear the gate → merge → close the card → tell the
  coordinator → continue the batch. "Ready for you" only for an owner-only decision.
- **C22 Wait record.** A waiting card records the condition, who acts next, what wakes it, its
  owner (thread or coordinator), PR, commit, next action, deadline. Stalls go to that owner,
  missing cards to the coordinator.
- **C23 Cleanup is part of done.** Every reminder, check-in, routine and PR watch records the work
  it serves, what makes it act, what retires it and its coordinator; it retires when that work
  finishes, is cancelled or superseded (history kept, future runs off). A card closes only after its
  follow-ups are off; one-time items never re-create; with no work in progress nothing Claude is
  scheduled.
- **C24 Failure caps.** Caps count failed recovery, not waiting (CI running, usage-limit resets).
  Three unanswered wakes, or the same failed fix repeated → the coordinator takes over or changes
  approach, attempts recorded across threads. Truly stuck → one exception to the owner; other
  work continues.
- **C25 Waits wake themselves.** No turn ends waiting on CI, a review or another thread without one
  self-reminder (or watcher) at the expected finish. Each turn first reads the PR's checks, reviews
  and comments since last turn; new findings first. A wake reads the real state, then continues
  or sets one more; 3 per wait, then STOPPED with why. Merge decisions read the PR (checks green,
  review PASS recorded, no unanswered finding), never another thread's message alone. Reminders go
  at DONE (C23).