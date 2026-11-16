# The one-time permission line (A24)

> Lookup only. How a thread offers the owner one permission line so a step that keeps stopping on
> his own machine stops coming back to him. The rule is A24; the owner's file is his (standing
> approvals: permission settings are never changed by the agents they govern). Source: K045.

## When

The step is on an approved card and reviewed, and either a safety check or permission prompt on the
owner's own machine stops it, or it is a step he would otherwise repeat by hand and a permission line
lets an existing route (a remote-control route the project already runs) do it.

**Order.** An existing route that needs nothing from him first. Then this option. A manual step for
him comes last. A refusal ends the attempt at once (C14): log it where the project logs refusals, do
not retry, reword or move it; the offer below is the one thing that reopens it.

## Before it goes to him

He approves without reading, so the checking happens first.
1. The step is not on his reserved list (spending, going live in production, deleting data without a
   verified backup, secrets). If it is, there is no offer.
2. Each line is the narrowest that does the job: an exact command, not a whole machine. A script line is
   narrow only if the script comes from a reviewed commit on the default branch, sits at a path the agent
   cannot write (a checksum is not enough: the line matches the command text, not the file), and does not
   execute its arguments; any other script line is
   wide. A reviewer other than the author checks every line for width before it is sent.
3. A wide line (`ssh <host>:*` lets the thread run any command on that host) has a named reason and a
   look-again date, and is never given for a machine that holds real data.
4. The project's list (below) is read first; lines it already has are not asked for again, and several
   needed lines go out in one batch.

## The offer

One decision card with a recommendation (O03), then one message with the whole step. In order:
1. What was blocked, in plain words, and that nothing ran.
2. The decision: allow it on his machine, do it by hand once, or leave it; the recommendation first,
   with the cost of each in minutes.
3. The whole step to the keystroke: the keys, the file, the line to find, the lines to paste, save.
   Minutes stated.
4. What the lines open. A wide line gets its own plain sentence ("this lets me run any command as
   root on <host> from your laptop").
5. "Not tested until you do it. If it still refuses, I report the exact text and stop."
6. A last line that is the status word with the exact action (O02): `WAITING FOR YOU — add the lines
   and reply "done"`.

After he says done: read how the lines landed (the file parses, the lines sit inside the list, commas
are right) before using them. Read only the permission list (for example `jq '.permissions.allow'`,
which also proves the file parses), never the whole file: it can hold secrets (O04). Then run the step, one command at a time so each matches a line, and
report the result with proof (O08). Anything refused after the change is a new finding, reported with
the exact text; the thread stops there.

## The list

One file per project, in the repository that owns the machines, mirroring the owner's permission
lines. No secrets, no addresses. A table, one row per line:

| Line | What it opens | Width | Card | Added | Look again |
|---|---|---|---|---|---|
| `Bash(ssh <host>:*)` | any command on `<host>` as the logged-in account | wide: <reason> | <card> | <date> | <date> |
| `Bash(bash <script>:*)` | that script, any arguments | narrow only if the script is from a reviewed commit on the default branch, at a path the agent cannot write, and runs no argument as a command; otherwise wide | <card> | <date> | n/a or <date> |

- A thread reads it before it asks; it changes by a PR on the card that added or removed a line,
  and the owner's own file is the truth: if they differ, the list is corrected from his report.
- Narrow lines may stay. A wide line is looked at again on its date, and before the machine holds
  real data it is narrowed or removed.
- The list is not a permission: writing a line there changes nothing on any machine.
