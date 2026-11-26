# Harness Kit · core

> Loaded every session; binds every agent. Records: `catalogue/core.md`.
> The profile and rulebook win where stricter.

## The card

- **C01 Stages.** PLAN → BUILD → VERIFY → RELEASE → MAINTAIN (if any). A small fix is
  one card: it plans and builds, its checks verify, its merge releases.
- **C02 One outcome per card.** A card states its stage, goal, context, numbered pass/fail
  acceptance, the files it may touch, done-when and blocked-by.
- **C03 How a card ends.** Its closing note opens `DONE —`, `WAITING FOR YOU — <exact action>`
  (work waits on the owner), `WAITING ON <who> — <what>` naming its wake (C22), or `STOPPED — <why>`;
  then `Waiting for you:` · `Changed:` · `Found:` (`none` where empty); its last line repeats the
  status word. "Nothing" is never a status while work waits on anyone.
- **C04 Never stall silently.** End a turn only when the card is DONE or STOPPED, nothing can move
  without the owner, or a wake you set will come (C25). A wait that can outlast the session leaves
  a durable handover (branch, PR, done work, exact next step), then ends.
- **C05 Investigate first.** List each card assumption the code or canon contradicts; one that
  changes the work is STOPPED. "No work needed" is a valid DONE, with why.
- **C06 Scope.** Touch only the files the card names; a high-risk path only when named. Unasked
  extras go to NEXT, not the diff; scope or design asks in review are answered and escalated, not
  built. No new dependency unless named.

## Evidence

- **C07 Evidence.** A check counts only if it ran and exercised the change. A test's name, a skipped
  test or a report without results is not evidence. Evidence holds for the current candidate; a
  relevant change voids what it affects.
- **C08 Tests are never weakened.** Each new behaviour has a check that fails without it. Never
  skip, isolate, weaken or delete a test to get green; fix the cause.
- **C09 Proportionate verification.** Tier 1 (copy, comment, caller-less
  rename) builds; 2 (screens, components, non-privileged queries) investigates, builds, tests;
  3 (schema, migrations, auth, permissions, secrets, money math, config, CI, the harness, shared
  logic) maps the blast radius first and carries an authorization line naming its card. Unsure → 3.
- **C10 Independent review.** A tier-3 or profile-risky diff gets a fresh-context reviewer given
  only the diff and the rulebook: "List only problems you'd block the merge for: file, line, why,
  how to show it fails." Fix every block. Blocked after 3 rounds (+1 for a small final fix) →
  STOPPED.
- **C11 Build floor and release bar.** A merge is blocked only by a broken essential workflow in
  the changed area, a security failure, data corruption or broken money math. Every other finding
  is logged with a severity; a release leaves VERIFY with no blocker or major open in its scope.

## Merge and failure

- **C12 Gates hold.** The default branch changes only by PR. Merge on required checks green
  plus any required review with no block. Gates and approvals are never worked
  around, relaxed or impersonated.
- **C13 After the merge.** Confirm the default-branch CI run for the merge commit, its deployment
  (by commit, not time) and live probes; record a ship line. A red default branch is the
  next card and admits only fix PRs.
- **C14 Failure handling.** A refused command or safety refusal is a finding: report the exact
  command; never retry, reword or route around it. A missing repo, secret, connector or tool: name
  it; never mock, guess or swap in another; finish what does not need it. Three failures in a
  row on one step, or the turn budget → STOPPED with what is complete. `Found:` names what went
  wrong, its class (context · constraint · verification · planning) and its prevention (C19).
- **C15 No silent stall.** Green unmerged PRs, conflicted PRs and quiet cards are listed on a
  schedule; each resumes or is STOPPED.

## Canon

- **C16 Handover.** The closing note carries `RESULT · PR · CI · CHANGED · VERIFIED` (behaviour →
  the check that proved it, with its run or output) `· FINDINGS · NEXT`.
- **C17 One home per fact.** Decisions are append-only: supersede, never edit. Volatile state lives
  only in the state file. Generated references are never hand-edited. Always-loaded
  text is capped; a cap rises only by the owner's decision.
- **C18 Ratchet.** A correction lands in its narrowest home (the card, a module rule, a
  test) and goes global only when it recurs. The owner's correction to how work runs is
  recorded as a decision the same day; chat is never the record.
- **C19 Prevention.** Every owner correction or repeated failure ends with its prevention, at the
  highest level worth its cost, recorded once (the `correct` skill). A one-off small mistake is
  fixed, not ruled. Owner review is no prevention; independent AI review counts only for risky areas.
- **C26 Stale instructions.** When descriptive repository instructions conflict with consistent
  patterns in the relevant existing code, preserve those patterns unless the current task explicitly
  requests a change. Never override security requirements, explicit prohibitions, the owner's numbered
  rules and decisions, or documented migration plans. Report each behavior-changing conflict in your
  final reply and file it as a card. A clean-up card (its kit template) may change patterns on purpose.

## Finishing and waiting

- **C20 Finish line.** A coordinator finishes the approved batch with its fixes, reviews, merges and
  dependent cards; no improvement rounds after. Ready cards start now, a thread each (`bulk.md`);
  one waits only on a running card's files or tables, or the owner.
- **C21 Full handoff.** A CI result is read (C25) → check the current commit and its required review
  (re-review after later commits) → clear the gate → merge or auto-merge (A06) → close the card →
  tell the coordinator → continue the batch.
- **C22 Wait record.** A waiting card records the condition, who acts next, what wakes it, its
  owner (thread or coordinator), PR, commit, next action, deadline. Stalls go to that owner,
  missing cards to the coordinator.
- **C23 Cleanup is part of done.** Every reminder, check-in, routine and PR watch records the work
  it serves, what makes it act, what retires it and its coordinator; it retires when that work
  finishes, is cancelled or superseded. A card closes only after its follow-ups are off; one-time
  items never re-create.
- **C24 Failure caps.** Caps count failed recovery, not waiting. Three unanswered wakes, three pushes
  for one failing check or comment, or a failed fix repeated → the coordinator takes over or changes
  approach, attempts recorded across threads. Truly stuck → one exception to the owner; other work continues.
- **C25 Waits wake themselves.** No turn ends waiting on CI, a review or another thread without one
  self-reminder (or watcher) at the expected finish. Each turn first reads the PR's checks, reviews
  and comments since last turn; new findings first. A wake reads the real state, then continues or
  sets one more; 3 per wait, then STOPPED with why. Merge decisions read the PR,
  never another thread's message alone.

## Finishing work

- **C27 Finishing work.** Anthropic's text below, unchanged (K049). It loosens no safety refusal
  (C14), reserved owner step (O01) or real-data tap (O19).

> Please avoid stopping while you still owe work the user asked for. Be persistent and do not stop unless needed.
>
> While status notes are welcome, as is clarifying with the user on open decisions, carry on with work that does not depend on the user's answer without unnecessary stops.
>
> If you notice yourself inviting the user to redirect you or offering to wait, instead proceed on the next part of the task. You may meet ordinary obstacles like errors, timeouts, locked files, empty results or failing tools. Diagnose them first, and when they are not real blockers, work through them with the access you have (wait and retry, fix the request, use another tool or source) rather than stopping unnecessarily.
>
> If someone clearly decided something is a hard blocker, such as a file marked not to be touched, access that was intentionally withheld, or a safety guardrail, leave it alone, say plainly what you found, and look for another safe way to finish the task. Stopping before the task is complete is very rarely merited, as in when the task can't move forward without user input, or where the blocker is deliberate and should not be worked past. This does not override the need for confirmation on risky or destructive actions.
