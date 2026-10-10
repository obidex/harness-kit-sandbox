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

## Pickup (K018, K024)

1. The sender files the request with `inbox.mjs send`. The wake is a comment on the receiving
   repository's **wake channel**: its open draft pull request from the branch `inbox-wake`, never
   merged. A repository that already keeps a general wake channel (branch `wake-channel`) uses that
   one, so each repository has one channel.
2. An Actions job posts that comment, never a session (K024): every session acts as the owner's own
   GitHub account, and a subscribed session never receives a comment its own account posted. The
   receiver's `harness-inbox.yml` posts it, started by the `inbox` label (kit 0.22.0 or later; a
   resend sets the label again). For a repository without that job (no kit, or an older kit), `send`
   dispatches the control repository's `hands-inbox.yml`, which posts it with the hands App
   (`INBOX_HANDS_REPO`, default `<owner>/harness-hands`).
3. The receiving coordinator's session is subscribed to the channel, so the comment reaches it as a
   GitHub event. It runs the `inbox` skill.
4. "Woke" is written on the request only after GitHub accepted the wake comment; otherwise the job
   writes a "Not delivered" note. `send` waits for that answer (`INBOX_WAIT_MS`, default 3 minutes)
   and ends non-zero without "Woke". Nothing is lost: a resend of the same ID tries again, `send
   --again` wakes a still-queued request once more, and the coordinator's own `pending` check at the
   start of a turn finds it. Nothing ever asks a person to wake or relay (O15).
5. A project without a channel may fire a routine from `harness-inbox.yml` (`INBOX_ROUTINE_URL`,
   `INBOX_ROUTINE_TOKEN`); a routine fire is not proof the session ran, so the channel is the
   standard. A request already picked up or done wakes nobody.
6. A cloud session reaches a repository's API only when it is attached to the session with push
   access (`add_repo`); its `GH_TOKEN` is not a working token. `send` says so on a 401 or 403.

## Setup in a project (once)

1. The settings file declares the label:
   `{ "name": "inbox", "color": "5319e7", "description": "Cross-project request (Harness Kit inbox)" }`.
2. The coordinator opens the channel in its own repository:
   `node .harness/tools/inbox.mjs channel --repo <owner/name> --open` (a project without the kit runs
   the kit's copy of the tool). `channel` without `--open` checks it.
3. The coordinator subscribes its session to that pull request (`subscribe_pr_activity`) as the
   first step of every session, and the project's own instructions say so, so a new coordinator
   does it too.
4. Prove it once: a test request sent with `inbox.mjs send` shows "Woke" on the request and the
   coordinator picks it up with no one prompting it.

## Cost (O13)

The wake channel costs nothing: one comment per request on a pull request that never runs again.
`hands-inbox` (only for a receiver without its own job) runs one job of about half a minute per
dispatched wake: one GitHub-hosted minute each in a private control repository.
`harness-inbox` runs one job of a few seconds per labelled or reopened inbox issue, on
`${{ vars.RUNNER || 'ubuntu-latest' }}`: about one GitHub-hosted minute per request on a private
repository without a self-hosted `RUNNER`; none with the Actions variable `RUNNER` set to a
self-hosted runner's label, or on a public repository; nothing when no request arrives. A request
left queued or working for a day is listed by the stale-work check (`harness-stale`, C15). Each
pickup is one routine run, which counts against the owner's Claude subscription usage like any
session.
