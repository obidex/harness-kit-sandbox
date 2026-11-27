# Usage · where the weekly allowance goes

<!-- runbook -->

> Lookup only, never loaded. K072. The weekly allowance is spent by model calls, and every call re-reads
> its whole context (A25). This runbook measures, from the threads' own session records, what the
> allowance bought: by model, by role (the thread and each subagent by type), by what started the turn,
> and by whether its first call found the cache warm. It reads; it changes nothing.

**Where the records are.** A cloud thread cannot open another thread's session file. It reads other
threads only through two tools, `list_threads` (hearthbot) and `list_events` (claude-code-remote), and
their results stay in its own transcript under `~/.claude/projects/` or in the file a long result is
saved to. `node .harness/tools/usage.mjs` reads them back from there: no key and no network. Records
are private: the table goes on a private issue, never into a public repository.

**What it counts.** One wake is a thread's turn, from one `result` record to the next. Its record gives
what started it (`origin.kind`: an owner message, a background-task notice, a PR event, a reminder, a
schedule), its model calls and its price per model at list price (`costUSD`). The price of a model is
shared out over that wake's calls by weighted tokens, which gives each subagent its part. A short wake
ended within four model calls (A25's waiting share). The allowance's own meter is not readable by a
thread; the price is its proxy, and M2 below turns it into points of the week.

## Measuring a window (a coordinator, for its own project's threads)

1. Start one paging worker (Agent tool, `model: "haiku"`, low effort, in the background) with this brief,
   the window's start filled in: "Read-only paging worker. Load `mcp__hearthbot__list_threads` and
   `mcp__claude-code-remote__list_events`. Call list_threads with since=`<from>`, limit 100, following
   next_cursor. Then loop: run `node .harness/tools/usage.mjs next --from <from> --max 12`; make every
   list_events call it prints, exactly as printed, in parallel, never adding kinds, ignoring what comes
   back; stop when it prints DONE or after 40 rounds. Reply in 5 lines: rounds, calls, DONE or not,
   session ids that errored." Check: the worker's reply says DONE.
2. Print the table: `node .harness/tools/usage.mjs table --from <from> --to <to> --project <name> --md`.
   Check: its first line gives a price, a wake count and a thread count above zero.
3. Keep the records for the merge: `node .harness/tools/usage.mjs table --from <from> --to <to> --project <name> --json > usage-<name>.json`,
   then attach the file's content to the answer on the card that asked (a comment holding the JSON in a
   fenced block, or a file in the project's shared folder). Check: the JSON parses and its `wakes` list
   is not empty.
4. Post the table from step 2 on the card that asked (`gh issue comment <n> --repo <repo> --body-file <table>`), with the window and what was not read (a thread
   the worker could not page). Check: the comment shows the table and names the window.

## The whole picture (Platform)

1. Gather each project's JSON from step 3 above. No command: they arrive as answers on the inbox cards.
   Check: one file per project that ran.
2. Merge them and calibrate against a reading of the allowance page:
   `node .harness/tools/usage.mjs merge usage-*.json --from <from> --to <to> --points <n> --points-at <time of the reading> --since <the week's reset> --merged <project>=<merged changes in that span> … --md`.
   Check: the output ends with a calibration line in dollars per point and one points-per-change line
   per project.
3. Add the GitHub half of the baseline: `node .harness/tools/metrics.mjs --repo <r> --days <n> --md` for
   each repository. Check: every section prints a number or `?`, never a blank.

| What goes wrong | Do |
|---|---|
| `next` says no list_threads result was found | the worker skipped step 1's first call: start it again with the same brief |
| A list_events call errors for one thread (not found, no access) | leave that thread out and name it under "not read" in the posted table |
| `next` keeps printing the same call | the saved result was not written: run that one call yourself, then `next` again; after three, leave the thread out and name it |
| The table's price is far from what the allowance page shows | name the gap; a thread the worker missed, or work outside cloud threads (a laptop, Cowork), is not in the records |
| The window is wider than one day | start the worker with the earlier `--from`; `table --to` cuts the end |
