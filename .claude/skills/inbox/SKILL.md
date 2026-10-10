---
name: inbox
description: "Cross-project requests (owner default O14): send one to the repository that does the work as an `inbox` issue with a stable ID, or, as that project's coordinator, pick up queued requests, verify the owner decision that covers each, do the work, and post the evidence on the issue. Use for /inbox, when an inbox wake (a comment on the inbox-wake pull request) or a routine wakes you, and whenever work belongs to another project."
---

# Inbox

A cross-project request is an issue labelled `inbox` in the repository that does the work. The
tool is `node .harness/tools/inbox.mjs` (its header lists every command). Replies and progress stay
on that issue, and the sender reads the result there. Setup and cost: `.harness/inbox.md`.

## Sending a request

1. Pick a stable ID: `<your project>/<short-slug>`, the same every time you send this request.
2. Name the cover: the owner decision or standing delegation that already allows this work, as a
   link or an exact reference (a decision ID, or the owner's message with its date and words). No
   cover, no request: ask the owner instead (O01).
3. Run `inbox.mjs send --repo <owner/name> --id <id> --title <t> --outcome <what done looks like>
   --source <link to where it was asked> --coordinator <that project's coordinator> --covered-by <cover>`.
   Sending again with the same ID files nothing and prints the existing issue.
   `send` then starts the Actions job that wakes that project's coordinator on its wake channel and
   waits for its answer; never post the wake comment yourself (K024). `NOT delivered` (exit 3) means
   the request is filed but nobody was woken: it stays queued, a resend tries again (`--again` for
   one already woken), and you record it for your next scheduled check. A 401 or 403 in a cloud
   session: attach the repository with push access first. Never ask the owner to wake or relay (O15).
4. Read the result on the issue. Do not do the work yourself in the other repository.

## Picking up requests (the receiving coordinator)

**First step of every coordinator session:** subscribe to this repository's wake channel (the open
`inbox-wake` pull request, or the repository's existing `wake-channel` one; `inbox.mjs channel --repo <this repo>` names it, `--open` opens it once).
A comment on it is an inbox wake.

When an inbox wake or a routine wakes you, or at the start of a coordinator turn:

*If running `inbox.mjs` is refused* (a session may refuse code from a fresh clone), do each step
with the GitHub tools instead, never asking the owner to allow it: `pending` is the open issues
labelled `inbox` whose body has `- **State:** queued`; `state` is editing that line (for `done`,
also the `- **Evidence:**` line, then closing the issue as completed) plus a comment `**working**`
or `**done**: <evidence>`. The refusal is still a finding (C14): name the exact refused command
in `Found:` (class: constraint, prevented by this fallback, kit 0.17.1).

1. Run `inbox.mjs pending --repo <this repo>`. If it prints `[]`, stop: there is nothing to do and
   nothing to report.
2. For each queued request, oldest first:
   1. **Verify the cover before anything else.** Open what "Covered by" names and confirm it exists,
      is the owner's own decision or a standing delegation, and that the Outcome falls inside its
      scope. Citing a decision never expands it: work outside its words is not covered. If it does
      not hold, run `state --to blocked --note "<why; what owner decision is missing>"`, add the item
      to the owner's batch, and go to the next request.
   2. Run `state --to working`. A request already `working`, `blocked` or `done` is never picked up
      again, so a redelivered wake does no work twice.
   3. Do the work under this project's own rules (card, PR, gates). Progress goes as comments on the
      issue.
   4. Run `state --to done --note "<evidence>"`: the PR, the check run, the command and its output.
      This closes the issue. The sender reads it there.
3. End the turn. Nothing goes to the owner unless a request is blocked on him.
