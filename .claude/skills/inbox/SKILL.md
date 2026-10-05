---
name: inbox
description: "Cross-project requests (owner default O14): send one to the repository that does the work as an `inbox` issue with a stable ID, or, as that project's coordinator, pick up queued requests, verify the owner decision that covers each, do the work, and post the evidence on the issue. Use for /inbox, when a routine wakes you for an inbox request, and whenever work belongs to another project."
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
4. Read the result on the issue. Do not do the work yourself in the other repository.

## Picking up requests (the receiving coordinator)

When a routine wakes you, or at the start of a coordinator turn:

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
