---
name: correct
description: "Turn an owner correction or a repeated failure into a prevention: find the mistake class, make it impossible at the highest level that works (architecture, types, a check naming the fix, a behaviour test, a rule last), diagnose repeats first, prove each prevention catches a real failure and accepts correct code, and keep the prevention register. Use for /correct, after any owner correction, and when the same mistake happens twice (core C19)."
---

<!--
Adapted from pstack's `correct` skill: https://github.com/cursor/plugins, pstack/skills/correct/SKILL.md
MIT License. Copyright (c) 2026 Lauren Tan. Permission is hereby granted, free of charge, to any
person obtaining a copy of this software and associated documentation files (the "Software"), to
deal in the Software without restriction, including without limitation the rights to use, copy,
modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
persons to whom the Software is furnished to do so, subject to the following conditions: The above
copyright notice and this permission notice shall be included in all copies or substantial portions
of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES
OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
Changes for the Harness Kit (K004): escalation threshold, no owner approval for exceptions, owner
review is not a prevention, evidence sources, diagnosis before escalating, priority by impact,
the register in lookup docs, release tracking of existing defects, two-sided proof (K005).
-->

# Correct

The owner, a reviewer or a failing check keeps catching the same mistakes. Change the project so the
next agent cannot make them (core C19).

Assume every contributor is an agent that sees only the files it opened, copies the nearest example,
and takes the shortest path that compiles. A change that looks right from one file must be right for
the whole project.

## 1. Find the mistake classes

Read the evidence: recent commits and reverts, review and verifier findings, the `Found:` lines of
recent threads and cards (C14), owner corrections, and comments that explain workarounds. Group the
mistakes into classes.

- **Escalate** a class once it has happened twice, or once if it was costly (lost data, a red
  default branch, a security or money error, owner time).
- **A one-off small mistake** is fixed, not ruled: no new check, no new rule.
- **Already in the register and still happening** is a repeat. Diagnose it first: the existing
  check may not have run, may be wired wrong, or may cover the wrong boundary. Fix that before
  escalating; move the class up a level only when its enforcement, working as intended, still lets
  the mistake through.
- **Prioritize by impact and recurrence**, not frequency alone: one costly class outranks several
  cheap ones.

## 2. Fix each class at the highest level that works

1. **Architecture and one source of truth.** Give each piece of state one owner and each task one
   supported way. Hide internals so the wrong import fails. Replace hand-synced lists with one source.
   Delete old ways and dead code an agent would copy.
2. **Types**, so the bad state cannot be written.
3. **A lint or CI check whose error names the fix**: the file, type or function to use instead. If
   the pattern is already common, fail only on new occurrences (the C18 ratchet), never on the
   existing ones.
4. **A behaviour test.** Reject or fix any test that would still pass if every function it calls
   returned nothing.
5. **A rule, last, only for judgment calls.** Nothing fails when an agent skips a rule.

Not levels: "the owner will review it" never counts. An independent AI review (C10) counts only for
risky areas, where no check can decide.

## 3. Fix and prove

- Fix the highest-priority classes first (§1), one commit each.
- **Prove both sides of each prevention**: it catches a representative failure (re-apply a real past
  mistake, or check out its commit, and show the check failing with its message) AND it accepts
  correct behaviour (show it passing on the fix and on existing correct code). Cite both outputs (C07).
- **Existing defects stay tracked.** When a check fails only on new occurrences, every serious
  existing occurrence stays on the release's tracked findings (C11) until fixed; the ratchet hides
  nothing from a release.
- **Same command locally and in CI.** The check is a project command, and CI calls that command.
- **Exceptions** go on the offending line with a reason and an expiry date. The reviewer checks
  both, and an expired exception fails. Exceptions never need an owner approval.

## 4. Keep the prevention register

One table, `Rule · What enforces it · Where it lives · Proven by`, in a lookup doc of the project
(`docs/preventions.md` unless the project names another), never in an always-loaded file such as
`CLAUDE.md`, `AGENTS.md` or an imported file. Each prevention is recorded there once.

- When corrected: fix the mistake; for an escalated class, add or raise the row in the same change.
- A row whose enforcement is "nothing" is a rule; keep those few and judgment-only.
- Drop a row once its mistake cannot happen (the architecture or type removed it).

## Reply

Each class with its evidence, the level picked and why a higher level did not work, the proof that
the prevention catches the past mistake and accepts correct code, and the register rows changed. In a card, this is the
`Found:` line's "where it is now prevented" (C14).
