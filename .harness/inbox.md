# Harness Kit · the inbox

> Lookup only, never loaded by default. Cross-project requests (O14, K009): the issue shape, the
> pickup wiring, setup and cost. The procedure is the `inbox` skill.

## The issue

One request is one issue labelled `inbox` in the repository that does the work, filed with
`inbox.mjs send`. Its body holds a hidden marker `<!-- inbox-id: … -->` and seven lines: ID,
Source, Outcome, Responsible coordinator, Covered by, State (`queued`, `working`, `blocked`,
`done`) and Evidence. Only `inbox.mjs` edits them. The ID is stable, so a redelivered request finds
the existing issue and files nothing. `done` closes the issue with its evidence; replies and
progress are comments on it.

A request proceeds only if an existing, verified owner decision or standing delegation covers its
scope; citing a decision never expands it.

## Pickup

1. The `inbox` label is added (at filing) or the issue is reopened.
2. `harness-inbox.yml` runs one short job: `inbox.mjs wake`. It does nothing unless that issue is a
   queued request, so the AI runs only when there is work, and a request already picked up never
   wakes anyone again.
3. `wake` fires the receiving coordinator's routine with the issue link. The routine's session runs
   the `inbox` skill: verify the cover, mark working, do the work, post the evidence, mark done.

## Setup in a project (once)

1. The settings file declares the label:
   `{ "name": "inbox", "color": "5319e7", "description": "Cross-project request (Harness Kit inbox)" }`.
2. A routine for the project's coordinator: its prompt runs the `inbox` skill for this repository,
   with the repository attached. It needs no schedule.
3. The owner adds an **API** trigger to that routine at claude.ai/code/routines (Edit → Add another
   trigger → API → Generate token) and stores the URL and token as the repository's Actions secrets
   `INBOX_ROUTINE_URL` and `INBOX_ROUTINE_TOKEN`. Creating the token is his (O01); it is never pasted
   into chat (O04). Without them, `wake` fails loudly on the first queued request.

## Cost (O13)

`harness-inbox` runs one job of a few seconds per labelled or reopened inbox issue: about one
GitHub-hosted minute per request on a private repository, none on a public one or a self-hosted
runner, and nothing when no request arrives. Each pickup is one routine run, which counts against
the owner's Claude subscription usage like any session.
