# Models and effort · what runs where

> Lookup only, never loaded. Part of K049. The roles are O06 and A23; this file holds the facts they
> are tuned to and Anthropic's effort advice. Re-check the facts when a model or a default changes.

## Facts (checked 19 Nov 2026, from the session records of one owner's projects; the builder and review rows set by K066, 25 Nov 2026)

| Run | Model | Effort | How it was checked |
|---|---|---|---|
| Coordinator (the project chat) | Opus 5.5 | low | its session record |
| Coordinator's planning (a batch, a card's design) | Fable 5.2 | high | K066 (owner, 25 Nov 2026) |
| Builder thread, clear and bounded work | Opus 5.5 (1M context) | medium | K066; Sonnet 5.5 on 19 Nov, no longer the default |
| Builder thread, risky or machine work | Opus 5.5 (1M context) | high | a recent thread's session record; K066 |
| Builder thread, a rules or process package | Opus 5.5 (1M context) | medium | its own session record; K066 |
| Builder thread, a tier-3 change (C09) | Fable 5.2 | high | K066 |
| Fresh-context independent reviewer (C10) | Fable 5.2, named by the call | high | K066; before it, the parent's model unless named |
| Other subagents | the parent thread's model, unless the call names one | the parent's | Claude Code's subagent default; not named in most cards |
| Scheduled "OK" kickoff task | Haiku 5.5 | default | the task's settings |
| Event-fired coordinator and doorbell tasks | the account default (no model set) | default | the tasks' settings |
| CI jobs that call the API (credit check, failure digest) | Haiku 5.5 | none | the workflow files |
| The owner's laptop (Remote Control and his own sessions) | his largest model at the top effort | top | his screenshot of 11 Nov 2026; he changes it, never an agent |

**21 Nov 2026:** a scheduled daily-start check that named no model stopped on the weekly limit of
the account's default model. Since K058 every helper task names Haiku in its settings.

**Claude Fable 5.2** was no one's default on 19 Nov 2026: no session, task or workflow named it. Whether a
cloud thread can be started on it is proved by the first clean-up card (part C of the initiative), which
asks for it and reports the model it actually ran on.

**25 Nov 2026 (K066):** the account's weekly usage limit stopped all work for nearly three days of seven.
Published guidance names Opus 5.5 the daily driver and says Fable 5.2 spends the weekly limit faster. The
owner set the mix: every builder thread on Opus 5.5; Fable 5.2 only for a coordinator's planning, a tier-3
change and an independent review; Haiku for chores as before. Each coordinator's state note says which
models its threads used (`wake.md` §6), so a mix that drains the week shows before it stops work. Goal:
the weekly allowance lasts seven days. The second reviewer and the full check (`review.md`) run on API
credit, not on this allowance, and keep their own models.

## Effort (Anthropic, "Prompting Claude Fable 5.2", read 19 Nov 2026)

- `high` is the API default for Fable 5.2 and suits hard coding, research, agentic work and long
  unattended runs. Most of the gain is reached at `high`.
- `medium` suits interactive coding, chat and everyday work: move down to it wherever results hold.
- `low` suits quick, well-specified tasks and high-volume helpers (fast subagents, log digests).
- `xhigh` and `max` only where a gain was measured: more tokens, uneven gains.
- Below `high`, agentic work stops early more often: C27 (Finishing work) is loaded for that reason.
- Effort barely changes reply length; prompting does.
- Subagents can be a large share of a session's cost. A subagent call names its model and effort when
  the parent's would be wasteful (a read-only search on a smaller model); otherwise it inherits them, knowingly.
- Re-tune effort when the model changes; levels rank the same across models but think different amounts.

## How the roles apply it

| Work | Model | Effort |
|---|---|---|
| Log digest, read-only helper; the state note and a failed log, briefs in `lookups.md` (K070) | Haiku | low |
| Scheduled helper task (a daily start, a check-in, a kickoff), named in its settings, never the account default (O06, K058) | Haiku | low |
| Builder thread, clear and bounded (tier 1-2) | Opus | medium |
| Builder thread, hard, risky or unattended (tier 1-2) | Opus | high |
| Tier-3 change (C09) | Fable | high |
| A coordinator's planning (a batch, a card's design) | Fable | high |
| Independent review (C10, O07) | Fable | high |
| Second review of a pull request, and the full check of existing code (`review.md`, K054, K055) | Sonnet; Opus on high-risk paths | medium |
| Coordinator turns (routing, short replies) | as set by the platform | low or medium |
| Anything at `xhigh` or `max` | only with a measured gain, recorded on its card | |
