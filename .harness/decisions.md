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
- **Superseding** is a new file that names the one it replaces. A written file is not edited. The tool
  writes it: `node .harness/tools/decisions.mjs new --supersedes <ID>` (K079); to answer an edit already in
  history, add `--commits <sha>,…`, and the audit's C17 reads the new decision as that edit's record.
- **References** stay as they were: other files cite the ID, never the path.

## Two threads, one number

The path is the number, so two threads that take the same number add the same file and git shows
the clash on the later pull request before anything merges. The later thread renames its file to
the next free number and corrects its own references; it never merges two texts. To make this rare,
a thread takes its number late: after its work is built, with the default branch fetched.

## The check

Where the edit is made (K079): `node .harness/tools/precheck.mjs` holds this change in about a second (a
decision edited, the log losing lines, the register, a cap), and `--install` makes it the clone's pre-commit
hook; `harness-audit` runs it on every pull request. A laptop session may also run it after each edit of a
decision file (a `PostToolUse` hook on Edit and Write in the project's own `.claude/settings.json`).

`node .harness/tools/decisions.mjs check` fails when a file is not named `<ID>.md`, when its first
line names another ID, when a number is used twice, or when the log gained an entry after the
switch (any log number at or above a file's). The audit's C17 runs the same check and flags a
decision file changed after it was written; the kit runs it on itself in `check-kit`.

## Switching a project

Nothing to migrate. From the kit release a project installs with this file, its next decision is
written as a file; its rulebook's pointer to the register names the folder too. A thread that
started on the older kit and appended to the log is caught by the check and moves its entry into a
file. That move removes lines from the closed log; when the move is word for word, the audit proves it itself and
C17 passes with no baseline line (K079). A move that changed anything on the way is listed for C17 in the
audit baseline (`commits`, with `why`), and C17 skips that commit only (K067).
A written decision file is never edited; the one exception is a change that only takes out what a rule
keeps out of files (a name, a host). Its commit is listed for C17 the same way, and the "never edited"
test skips that commit only (K073). An edit that is already in history for any other reason is answered by
a new decision that names it and its commit (`new --supersedes <ID> --commits <sha>`, K079).
