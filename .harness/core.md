# Harness Kit · core

> Loaded every session; binds every agent; profile and rulebook win where stricter. Records:
> `catalogue/core.md`.

## The card

- **C01 Stages.** PLAN → BUILD → VERIFY → RELEASE → MAINTAIN; a small fix is one card through them.
- **C02 One outcome per card.** Stage, goal, context, numbered pass/fail acceptance, files it may
  touch, done-when, blocked-by.
- **C03 How a card ends.** Its note opens `DONE —`, `WAITING FOR YOU — <exact action>`
  (work waits on the owner), `WAITING ON <who> — <what>` naming its wake (C22), or `STOPPED — <why>`;
  then `Waiting for you:` · `Changed:` · `Found:` (`none` where empty); the last line repeats the status.
  "Nothing" is never a status while work waits on anyone.
- **C04 Never stall silently.** End a turn only when DONE, STOPPED, waiting on the owner, or when a
  wake you set will come (C25); a wait that may outlast the session leaves a handover.
- **C05 Investigate first.** An assumption the code contradicts that changes the work is STOPPED.
  "No work needed" is a valid DONE, with why.
- **C06 Scope.** Only the files the card names; no new dependency unless named. Extras go to NEXT;
  scope asks in review are escalated, not built.

## Evidence

- **C07 Evidence.** Only a check that ran on the current candidate and exercised the change counts;
  a test's name, a skip or a report without results does not.
- **C08 Tests are never weakened.** Each new behaviour has a check that fails without it; never skip,
  weaken or delete a test to get green.
- **C09 Tiers.** 1 (copy) builds; 2 (screens, non-privileged queries) also tests; 3 (schema,
  migrations, auth, permissions, secrets, money, config, CI, the harness, shared logic) first maps the
  blast radius. Unsure → 3.
- **C10 Independent review.** Tier 3 gets a fresh-context reviewer with only the diff and rulebook:
  "List only problems you'd block the merge for: file, line, why, how to show it fails." Fix every
  block; blocked after 3 rounds → STOPPED.
- **C11 Build floor.** Only a broken essential workflow, a security failure, data corruption or broken
  money math blocks a merge; other findings are logged.

## Merge and failure

- **C12 Gates hold.** The default branch changes only by PR, on green required checks and any required
  review; gates and approvals are never worked around, relaxed or impersonated.
- **C13 After the merge.** Confirm the merge commit's CI, deployment and live probes; a red default
  branch admits only fixes.
- **C14 Failure handling.** A refused command or safety refusal is a finding: report the exact command;
  never retry, reword or route around it. Name a missing repo, secret or tool, never mock or swap it,
  and finish the rest. Three failures in a row on one step, or the turn budget → STOPPED with what is
  complete.
- **C15 No silent stall.** Green unmerged PRs, conflicts and quiet cards are listed regularly; each
  resumes or STOPS.

## Canon

- **C16 Handover.** The note carries `RESULT · PR · CI · CHANGED · VERIFIED` (each behaviour → its
  check) `· FINDINGS · NEXT`.
- **C17 One home per fact.** Decisions are append-only; volatile state lives only in the state file;
  generated files are never hand-edited; only the owner raises the cap on always-loaded text.
- **C18 Ratchet.** A correction lands in its narrowest home, global only when it recurs; an owner's
  correction to how work runs is a decision that day.
- **C19 Prevention.** Every owner correction or repeated failure ends with a prevention, as high as is
  worth it (`correct` skill); a one-off slip is fixed, not ruled.
- **C26 Stale instructions.** Repository text that conflicts with consistent code patterns yields to
  them unless the task says otherwise, never against security or the owner's rules; file the conflict.
- **C28 Papercuts.** When a tool, skill, rule or instruction fights you (a broken flag, a wrong step, a
  silent error, a rule you had to work around), file it once with `papercut.mjs file` and carry on.

## Finishing and waiting

- **C20 Finish line.** A coordinator finishes the approved batch (fixes, reviews, merges, dependent
  cards), no extra rounds; ready cards start now, a thread each.
- **C21 Full handoff.** CI read → current commit reviewed → merge or auto-merge → card closed →
  coordinator told → batch continues.
- **C22 Wait record.** A waiting card records the condition, who acts next, what wakes it, its owner,
  PR, commit, next action, deadline.
- **C23 Cleanup is part of done.** Every reminder, watch and routine retires with the work it serves;
  a card closes only after its follow-ups are off; one-time items never re-create.
- **C24 Failure caps.** Three unanswered wakes, three pushes for one failing check, or a repeated failed
  fix → the coordinator takes over or changes approach.
- **C25 Waits wake themselves.** No turn ends waiting on CI, a review or another thread without one
  self-reminder (or watcher) at the expected finish. A wake reads the real state, then continues or
  sets one more; 3 per wait, then STOPPED with why. Merge decisions read the PR, never another thread's
  message alone.

## Finishing work

- **C27 Finishing work.** Anthropic's text, unchanged (K049); it loosens no refusal (C14), owner step
  (O01) or tap (O19).

> Please avoid stopping while you still owe work the user asked for. Be persistent and do not stop unless needed.
>
> While status notes are welcome, as is clarifying with the user on open decisions, carry on with work that does not depend on the user's answer without unnecessary stops.
>
> If you notice yourself inviting the user to redirect you or offering to wait, instead proceed on the next part of the task. You may meet ordinary obstacles like errors, timeouts, locked files, empty results or failing tools. Diagnose them first, and when they are not real blockers, work through them with the access you have (wait and retry, fix the request, use another tool or source) rather than stopping unnecessarily.
>
> If someone clearly decided something is a hard blocker, such as a file marked not to be touched, access that was intentionally withheld, or a safety guardrail, leave it alone, say plainly what you found, and look for another safe way to finish the task. Stopping before the task is complete is very rarely merited, as in when the task can't move forward without user input, or where the blocker is deliberate and should not be worked past. This does not override the need for confirmation on risky or destructive actions.
