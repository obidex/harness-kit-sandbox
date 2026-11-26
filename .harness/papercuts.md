# Papercuts · agents report their own friction

<!-- runbook -->

> Lookup only, never loaded. C28, K070. The always-loaded rule is one line; this is how it works. A
> papercut is a tool, skill, rule or instruction that fought the work: a broken flag, a wrong step, a
> silent error, a rule a thread had to work around. The thread files one short report and carries on.
> Nobody fixes it on the spot; the weekly digest turns the most-reported ones into cards.

**Where reports go.** One private issue per project, labelled `papercut`, whose body the tool keeps:
a count line (`<!-- papercut-count: open=N week=M -->`, which a status page reads) and a table
grouped by what was reported. The profile's `papercuts` (`owner/name#N`) names it; unset, it is the
repository's own open issue labelled `papercut`, which the first report opens. A public repository
is refused: a report describes the project's own work. A session that works in a public repository
(the kit itself) files to its project's private issue with `--to`.

**What a report holds.** Four fields, one line each, at most 400 characters: what was tried, what was
expected, what happened, and the fix the thread would make. Secret-shaped text is refused before
anything is posted. Reports are comments with the marker `<!-- papercut -->`; nobody edits them.

## Filing one (any thread)

1. File it once, the first time the thing fights you, and go on with the work:
   `node .harness/tools/papercut.mjs file --what "<tool, skill, rule or file>" --tried "…" --expected "…" --happened "…" --fix "…" --by "<thread or card>"`.
   Check: it prints `papercut: filed <link>`; the issue's count line went up by one.
2. When the tool refuses (exit 1) or GitHub does not take it (exit 3), put the printed report in the
   closing note's `Found:` line instead. No command: the closing note is written by hand.
   Check: the note's `Found:` line carries the four fields.

## The weekly digest (the coordinator's run)

3. Each coordinator run asks whether the digest is due:
   `node .harness/tools/papercut.mjs due --to <home issue>`.
   Check: the last line is `PAPERCUTS: DUE` or `PAPERCUTS: NOT DUE`.
4. When it is due, group every project's open reports in one ranked table and post it on the
   home issue (the papercut issue of the project whose coordinator runs the digest): `node .harness/tools/papercut.mjs digest --from <issue> --from <issue> … --post <home issue>`.
   Check: the home issue has a new comment with `<!-- papercut-digest -->`, and `due` now prints
   `NOT DUE`.
5. File one card for each of the top three groups, in the repository that owns the thing (an inbox
   card for another project, O14), naming the reports it answers:
   `node .harness/tools/inbox.mjs send --repo <owner/name> …` or a card in this repository.
   Check: each of the three groups has a card link in the run's STATE note.
6. When a fix ships, mark the group fixed so the count drops and a later report counts again:
   `node .harness/tools/papercut.mjs fixed --what "<name>" --note "<PR or release>" --to <issue>`.
   Check: the issue's table shows the group as fixed and `open=` dropped by its reports.

| What goes wrong | Do |
|---|---|
| `file` exits 1: "public repository" | file with `--to` the project's private papercut issue; else write the report in `Found:` |
| `file` exits 1: secret-shaped text | remove the value from the report and file it again; never paste the value anywhere else |
| `file` exits 3 (401, 403, 404) | attach the repository with push access (`add_repo`) and file again; else write the report in `Found:` |
| `due` prints DUE every run | check that `digest --post` named the same issue that `due --to` reads |
| two reports name the same thing differently | the grouping ignores case and backticks only; name the file or tool exactly, as `--what` |
| `due` says NOT DUE while another project's issue has open reports | `due` counts only the home issue's reports: run step 4 anyway once a week when another project's count line shows `open=` above 0 |
| a project's issue is missing from the digest | add its `--from`; each project's issue is listed in the home project's state note |
