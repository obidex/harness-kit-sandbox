# Decisions · one file each

> Lookup only, never loaded. K052 (owner 20 Nov 2026: "decisions written one file per decision so
> parallel threads stop conflicting"). The tool is `tools/decisions.mjs`; C17 is unchanged: a
> decision is append-only, superseded and never edited.

## Why

A register kept as one file gains every new entry on its last lines. Two threads that each record
a decision therefore always conflict, and with every ready card running at once (`bulk.md`) that is
every batch.

## The shape

- **The log is closed.** The project's existing register (profile `canon.decisions`, for example
  `docs/DECISIONS.md`) keeps every entry it has, unchanged, and gains none. Nothing is moved or
  split, so no thread's open work conflicts with the switch.
- **A new decision is a new file**: `decisions/<ID>.md` beside the log (`docs/decisions/I091.md`).
  The ID is the next free number in the project's own series
  (`node .harness/tools/decisions.mjs next`). The file's first line names the ID in the project's
  usual entry shape (`## K051 · 2026-11-20 · STANDING — title`); the rest is the entry as before.
- **Superseding** is a new file that names the one it replaces. A written file is not edited.
- **References** stay as they were: other files cite the ID, never the path.

## Two threads, one number

The path is the number, so two threads that take the same number add the same file and git shows
the clash on the later pull request before anything merges. The later thread renames its file to
the next free number and corrects its own references; it never merges two texts. To make this rare,
a thread takes its number late: after its work is built, with the default branch fetched.

## The check

`node .harness/tools/decisions.mjs check` fails when a file is not named `<ID>.md`, when its first
line names another ID, when a number is used twice, or when the log gained an entry after the
switch (any log number at or above a file's). The audit's C17 runs the same check and flags a
decision file changed after it was written; the kit runs it on itself in `check-kit`.

## Switching a project

Nothing to migrate. From the kit release a project installs with this file, its next decision is
written as a file; its rulebook's pointer to the register names the folder too. A thread that
started on the older kit and appended to the log is caught by the check and moves its entry into a
file.
