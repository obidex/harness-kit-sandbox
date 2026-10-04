# The rule catalogue

Lookup only: never imported into a session. One record per rule ID, in tables with exactly these
columns, all non-empty (`tools/check-kit.mjs` enforces it):

| Column | Meaning |
|---|---|
| `ID` | Permanent address (K002). Never reused. |
| `Applies when` | The condition under which the rule binds; `always` when unconditional. |
| `Expected outcome` | What is observably true when the rule holds: what an audit looks for. |
| `Source` | Where the rule came from (see below). |
| `Verify` | `script:` a structural check a machine can run, or `judgment:` what a reviewer samples. Many have both. |

The rule's own wording lives once, in its layer file (`core.md`, `owner-defaults.md`,
`capabilities.md`, `presets/*.md`, `adapters/*.md`); the record holds only the fields above.

**Sources.** `K###` is an entry in `DECISIONS.md`. `ERP` and `WEB` are the two first projects'
harnesses (a web app and a public website) as read on 2026-10-04; a source names the file and
section and, where one exists, the project's own decision number (`D###` ERP, `W###` WEB). No
text of theirs is copied here. `COURSE` is the harness-engineering course found in H1's bounded
search (K002 §5). `PLATFORM` is documented Claude Code or GitHub behaviour.

**Results** an audit gives a record (K001, card H2): `PASS` · `FAIL` · `UNKNOWN` (missing access is
always UNKNOWN, never PASS) · `NOT APPLICABLE` (its `Applies when` is false), each with evidence.
