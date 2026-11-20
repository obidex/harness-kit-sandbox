# Clean-up card · template (pilot, K049)

> Lookup only, never loaded. A project copies the block below into a new card, fills the `<…>` parts and
> runs it as one thread. C26's exception covers this card only: it may change existing patterns on
> purpose, inside the module it names. Every other rule holds (C06 scope, C08 tests, C10 review, C12 gates).

**Pilot cap.** One clean-up card per project per week, for two weeks, then the pilot stops and reports
(step 7). A project pauses the pilot first when the weekly usage warning shows, and says so in one line.

---

**Stage:** BUILD · **Risk tier:** <1 or 2> · **Card:** clean-up pilot <n of 2>, <project>

**Goal.** Merge duplicated code, delete dead code and fix nearby problems in `<module or folder>`, and
report exactly what changed.

**Context.** Not yet allowed as a target: money, stock, sign-in and permissions, database changes and
migrations, CI and the harness's own files. Pick one module or folder of tier 1-2 code.

**Model.** <the model Anthropic measured the ownership sentence on, Claude Fable 5.2, when a thread can be
started on it>. If the thread runs on any other model, the result says: "the ownership sentence's effect is
unmeasured on <model>". The result names the model the thread actually ran on.

**Prompt for the thread** (this card only; never in always-loaded rules; in the project's rules "owner"
still means the human owner):

> You are the owner and long-term maintainer of this codebase, and its design is up to you.
>
> Scope: `<module or folder>` and the tests for it. Follow the steps below in order.

**Steps and acceptance**

1. **Before.** Run the module's tests and save the result (command and output) on the card.
2. **Public list.** List the module's public functions, routes and commands (the things other code or
   people call) in a file on the branch, `<module>/PUBLIC.md` or the card comment.
3. **Pin today's behaviour.** Where tests do not pin what the public list does today, write tests that do.
   Commit them alone, first, and show them green on the unchanged code.
4. **Work.** Merge duplicates, delete dead code, fix nearby problems. A change in how anything on the public
   list behaves goes in its own commit whose message says why.
5. **Tests.** The step-1 tests and the step-3 tests pass at the end (C07, C08: none weakened or skipped).
6. **Fresh reader.** A new subagent (fresh, not a fork of this thread) gets only: the branch name, the public
   list and the PR summary. It reads the diff itself and lists every change the summary leaves out and every
   change in public behaviour, with file and line. Its list goes under the PR summary, unedited. The card's
   normal review and merge gates still apply.
7. **Report** (on the card, at merge): duplicates merged, lines removed (`git diff --stat`), behaviour
   changes meant and not meant, what the fresh reader caught, output tokens or turn count against a normal
   card of the same size, and the model it ran on.

**Files it may touch:** `<module or folder>/**`, its tests, its public list.
**Done when:** the PR is merged on green with the fresh reader's list under its summary, and the step-7
report is on the card.
**Blocked by:** none.

---

**After the pilot** (six cards in all across three projects): the coordinator collects the six step-7
reports into one, and the owner picks: widen it, keep it as it is, or drop it.
