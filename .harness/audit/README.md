# Audit · how a project is checked against the kit

> Lookup only. Two parts, both reporting one result per rule ID: `PASS` · `FAIL` · `UNKNOWN` ·
> `NOT APPLICABLE`, each with evidence (K001, card H2). Missing access is `UNKNOWN`, never `PASS`.
> The audit measures behaviour, not paperwork: a template that names a field proves less than ten
> cards that used it.

## 1. Structural checks (cheap, automatic)

`node .harness/tools/audit.mjs . --strict` reads the checkout, `.harness/profile.json` and, with
`--repo owner/name`, GitHub's rulesets, default-branch runs, labels and open issues. It decides every
rule whose `Verify` has a `script:` part that can be checked generically; the rest come out `UNKNOWN`
with "judgment review" as evidence.

- **When it runs.** The installed workflow `harness-audit.yml` runs it on pull requests that change
  `.harness/**`, `CLAUDE.md`, `AGENTS.md`, `.claude/**` or `.github/**`, and weekly with GitHub
  access. A FAIL on a pull request names the rule and the evidence.
- **What it cannot see.** Settings only the owner can read, a host's runner guards, a hosting
  dashboard, alert history: those stay `UNKNOWN` until the judgment review settles them by sample.
- **Heuristics are findings, not verdicts.** A structural FAIL whose evidence shows a recorded,
  justified exception (a comment naming the rule, a profile `exceptions` entry) is settled in the
  judgment review as PASS with that citation, or as a conflict (below).
- **The baseline.** `.harness/audit-baseline.json` (project-owned) lists accepted results, each with
  `why`. An entry with `result: FAIL` accepts that rule's FAIL in `--strict`. An entry with `commits`
  (SHAs, 7+ characters) is a known exception instead: A10 and O09 skip exactly those commits (history
  is never rewritten) and still FAIL on any other, so the exception never hides a recurrence.

## 2. Judgment review (sampled, by a fresh-context reviewer)

Run by an Opus reviewer with read-only access, never by the thread that did the work (O07). Input: the
structural JSON (`--json`), the profile, read access to the repository and its issues and PRs.

1. **Sample recent active work.** The last 8 closed cards (find them by the card template's
   headings, not only by label: labels drift), the last 10
   merged PRs, every open PR older than 3 days, and the last 3 runs of each scheduled job. Name the
   sample in the report so a re-run can repeat it.
2. **Cards end in a valid outcome or a durable handover (C03, C04, C16).** For each sampled card, read
   its last thread or issue comment: it opens `DONE —`, `WAITING FOR YOU —`, `WAITING ON —` or
   `STOPPED —`, or, if unfinished, a handover names branch, PR, done work and the exact next step.
   A `WAITING FOR YOU` whose next action is not the owner's, a `WAITING ON` with no named wake, or
   "nothing" as a status while a party has an action is FAIL. A turn that ended waiting on CI, a
   review or another thread with no reminder or watcher set, a finding posted mid-turn that the
   next turn did not answer, or a merge decided on another thread's message alone is FAIL (C25).
   Count them.
3. **Evidence is real (C07, C08).** For each sampled PR, follow its VERIFIED lines to the run they cite:
   it ran on the merged head and exercised the change. A claim with no run, or a run on another commit,
   is FAIL.
4. **Enforcement really requires the intended checks (C12, A11, C09).** Compare the structural ruleset
   result with what happened: did any sampled merge land with a required check red, skipped or absent?
   A required job that a workflow-level or job-level `if:` can skip satisfies the ruleset without
   running; so does a non-strict required check computed before a newer merge. Both are FAIL.
5. **Jobs are bounded and fail loudly (RJ01–RJ04, O10).** For each sampled scheduled run: it ended
   within its timeout; a failure produced or updated exactly one tracking issue; alerts were not sent
   for success; three failures in a row stopped the job.
6. **State reflects real progress (C17).** The state file's "current" claims match the repository: the
   PRs it names as merged are merged, its open items are open, its next step is not already done.
7. **Conflicting rules are flagged, not resolved.** Where the project's rulebook and the kit disagree,
   or two kit rules pull apart in practice, record a `CONFLICT` line naming both sides and the kit's
   `project-specific.md` X-ID if one exists. The owner decides; the review does not.
8. **Corrections that recurred (C19).** List the owner corrections and repeated `Found:` classes in
   the sample. For each, name the prevention-register row and the enforcement it records; a class that recurred
   after its prevention was recorded, or a repeat with no row, is reported with both occurrences.
9. **Settle the rest.** Every rule still `UNKNOWN` gets a result from the sample, or stays `UNKNOWN`
   with what access would decide it.

## 3. The report

One Markdown file per project: header (kit version, commit audited, date, sample), totals, then a
table `ID · Result · Evidence` with links to the issues, PRs and runs cited, then `CONFLICT` lines,
then the top findings in priority order (build-floor first, C11). Reports about a real project are
private: they are delivered to the owner where he works, never committed to the kit's repository.
