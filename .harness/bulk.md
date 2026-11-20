# Bulk work · every ready card at once

> Lookup only, never loaded. The record behind C20's second sentence (K051, owner 20 Nov 2026). It
> replaces the old pacing ("next items start by board order when a slot opens") and any project
> limit on how many threads run at once.

## The rule

1. **No limit on threads.** Every ready card starts now, each in its own thread, all at the same
   time. Nothing is held back to keep the number of threads small.
2. **Only two reasons to wait.** A card waits when it changes the same files or the same database
   tables as a card already running, or when it needs the owner. A waiting card says which
   (C22: its wait record names the running card or the owner step) and starts when that clears.
   "Ready" means approved and buildable: an Idea, a Later item or a card with an open owner decision
   is not ready.
3. **Subagents wherever they speed the work up.** A thread splits independent parts across
   subagents (searches, reviews, replays, files nobody else touches). Each is named with its model
   and effort, or inherits them knowingly (A23, `models.md`). The thread still owns the result.
4. **The owner's browser before any owner step.** A browser signed in as the owner, its extension
   and computer use on his machine are used whenever that removes a step of his (O17). The limits
   stay: no secret typed, read or copied; nothing paid; stop at a sign-in, a code or a payment page
   (O04, O05, O13).
5. **Protect what is scarce.** Threads are not scarce; these are, and a batch is laid out around them:
   metered CI minutes, a server's disk, a host's daily build or deploy allowance, API rate limits and
   any other counted allowance the project names. Before a batch starts many runs against one of
   them, the coordinator states the count against the allowance; cards that would exceed it queue for
   that resource and for nothing else. Use still grows only as O13 says.
6. **One report at the end.** The owner gets one report when the batch finishes, not one per card.
   Before that only an outage, a refusal (C14) or a step only he can take reaches him, bundled (O02).
   Threads still close card by card (C03, O16); their notes go to the coordinator.

## What does not change

- One outcome per card (C02), scope (C06), evidence (C07), review by risk (C10), the gates (C12).
  More threads never means a weaker check.
- One coordinator run at a time per repository (`wake.md`); the wake caps only stop loops.
- A decision is one file (`decisions.md`), so parallel threads no longer collide on the register.
- Two cards that turn out to touch the same file anyway: the later pull request is brought up to
  date on the server (A10) and its checks run again; if they truly conflict, the later card waits
  for the first to merge and is rebuilt on it.

## An agent on a server

Until K051 no AI ran on any machine a project owns. That ban is lifted only where the owner lifts it
by name (capability rule HI05): it is proposed on a card when uninterrupted work needs it, and
nothing is installed, signed in or started on the machine before he approves that card.
