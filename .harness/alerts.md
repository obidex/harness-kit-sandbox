# Harness Kit · alerts

> Lookup only, never loaded by default. The owner's one notification standard (O10, K010, K037): the kinds, the group,
> the rules, how each kind of sender uses it, who runs the clock, setup and cost. The tool is
> `tools/notify.mjs`; every rule below is enforced there and tested in the kit (`tools/test-notify.mjs`).

## Kinds: what a sender reports (K037)

Senders name a **kind**, never a channel, so the channel can change without touching them. The owner's
group gets only the first four; everything technical goes to the Ops board. `problem` (below) is the
older form, kept until every sender has moved to a kind.

| Kind | Command | Where | What the owner sees |
|---|---|---|---|
| `needs_you` | `needs_you --key --what --step --where --when [--minutes] [--link]` | "Needs you", loud by day | the owner's five lines (below). Several due together go as **one** message, each step numbered; it turns `✅ Sorted: …` when the last of them is sorted |
| `outage` | `outage --key --system <Website, ERP> [--who]` | "Needs you", always loud | `⚠️ Website is down since 11:05` / `Who: Platform` / `Do: nothing` / `When: now`. Resolve edits the same message to `✅ Website was down 12 min. Fixed.` / `Do: nothing` (an edit is silent; never a second message). Also a 🛑 row on the Ops board |
| `good_news` | `good_news --text [--key] [--summary-only]` (the last two only on a host's file store) | "Good news", silent | `🎉 ERP: the purchase orders screen is live. Staff can use it now.` / `Do: nothing`. One key goes out once; `--summary-only` keeps it for the summary |
| `summary` | `summary [--stores] [--progress <line>]…` | "Summary", 20:00 Damascus | ☀️ the five lines: what went live and what is in progress; `Who: you` with his first open step (and how many more) when something waits on him, else `Who: Platform`, `Do: nothing` and `Where: <the Ops board>`. No message on a day with nothing to say; once a day; needs a file store among `--stores` |
| `ops` | `ops --key --text [--link] [--system] [--who]` | the Ops board only | nothing: one comment per problem and per resolve, the board's row ⚠️ then ✅ |

- **The owner's format (owner, roadmap #59, 8 Nov 2026; K038).** Every owner-facing message is at most
  five lines, plain words:
  ```
  🛑 <what's wrong, in business words>
  Who: you | Platform | ERP | website
  Do: <the exact action, or "nothing">
  Where: <the exact place, e.g. "ERP chat">
  When: <now | today | this week>
  ```
  The first line is an emoji and what happened; then only `Who:`, `Do:`, `Where:`, `When:`, in that
  order, `Do:` always. A message whose Who is not him is not his: it goes to the Ops board or one summary
  line, never to his group. No repository or issue numbers outside a quoted paste, no run ids, no
  "alert 2 of 3", no thresholds, no instruction meant for an agent ("Resume it or record why it
  waits"). `formatProblems` and `plainProblems` enforce it on every kind before it is sent, and the
  template test runs every template through both, so no template ships outside the format. Several
  alerts at once are one message, never several.
- **Replies to the owner in chat and threads** keep the same five parts (what happened, who, what he
  must do, where, when), one short line each, **without** the labels: start with the topic and end with
  the status word (DONE, WAITING FOR YOU, WAITING ON, STOPPED). Only the bot's messages carry the labels
  (owner, 8 Nov 2026).
- **Stale work is the agents' backlog, never his** (K038). `stale.mjs` keeps its list in the "Stale
  work" issue and, with `ALERTS_OPS_BOARD`, a row per item on the Ops board; it sends nothing to
  Telegram, and closes a problem an earlier kit sent with `resolve --quiet` (no message). Missed
  scheduled runs likewise.
- **The Ops board** is one issue in the repository `ALERTS_OPS_BOARD` names (`github:<owner/name>`,
  with `GH_TOKEN`), titled "Ops board" and found by its hidden marker. Its body is the live board
  (state, since when, who is on it), edited at every change; resolved rows go after 7 days. No text on
  it can @mention anyone. `notify.mjs board` opens it and prints its link. Pin it once (any session with write access can), and open it
  with a bot or App token, not the owner's, so GitHub never subscribes him. A board call that fails is
  retried by the next `tick`.
- **Rule C, enforced.** `needs_you`, `outage`, `good_news` and `summary` refuse a text with a
  filesystem path or file name, a size, an address or host name, a run or message id, an error code, or
  "You: nothing" (`plainProblems`); a link may carry a path. A refused message is an error in the
  sender's run, so its fixture catches it. `ops` carries technical text freely.
- **Rule D.** No message carries a button (the template test checks the source).
- **The clock.** A kind is never escalated or reminded: "Needs you" is already his, and the summary lists
  what still waits on him. On a host, `needs_you` and `ops` are held 10 minutes like any problem; an
  outage goes at once and is never capped. A stuck product wake (`pickup/<repo>#<n>`, infra I045) is a
  `needs_you` with the line to paste as its step.
- **Topics.** `setup` adds "Good news" and "Summary". Until it has run again, their messages reach the
  group's General thread with the topic's name leading them.

## The older senders go quiet (K039)

- `problem` still works for a sender that has not moved, but the owner keeps only three topics:
  `retire --topics kit,ops,daily` closes Platform's old ones (their history stays). A product's own
  topic (`erp`, `website`) closes once that product's senders use kinds. A problem in a closed topic
  closes without a reply. One still open there, or a new one a sender not yet moved raises there, moves
  to the Ops board as an ops row (`retiredTopic` names where it was): never escalated, never retried.
- `board --open` opens the Ops board if there is none and pins it. The bot or App runs it once
  (`hands-alerts` mode `board`), before any host writes to the board, so the owner's own token never
  opens it.
- `ops` in a GitHub store with no `ALERTS_OPS_BOARD` is recorded as that repository's alert issue,
  never sent; a host's reader (the VPS alerts job) mirrors such issues to the board. The kit's
  `hands-report` reports this way.
- `note --text [--link]` writes one line on the board's log with no row: what a host did by itself, a
  maintenance notice, a monthly count.
- `digest` is retired: it posts nothing (the evening summary and the board replace it). `test` sends
  one silent message in "Summary" and edits it to ✅.

## The group

One bot, one private Telegram group with Topics on. The bot creates the topics itself (`notify.mjs
setup`) and pins a config message listing their ids, so a sender needs only the bot token and the
group's chat id. Only the config stays pinned: senders read the chat's pinned message (the newest by sending date),
so `setup` unpins any later message pinned over it and every pin inside the topics, and a RESOLVED
unpins its problem.

| Topic | Key | Sound | What goes there |
|---|---|---|---|
| Needs you | `needs` | loud | only what needs the owner: an action-required event, a production outage, a problem escalated after 3 hours |
| ERP | `erp` | silent | the ERP's problems |
| Website | `website` | silent | the website's problems |
| Kit & Hands | `kit` | silent | the kit's and the hands workflows' problems |
| Laptop & VPS | `ops` | silent | the machines: the VPS, the home server, the laptop |
| Daily | `daily` | silent | one digest a day, 08:17 Damascus |

A new project gets its own topic: add it to `TOPICS` in `notify.mjs` (a kit release), then dispatch
`setup` again; existing topics are kept.

## The rules

1. **A problem is a key, and it must hold.** `problem --key <k>` opens it and sends one message. While it is open, the
   same key sends nothing more (deduplicated); in a GitHub store a repeat with `--link` adds a comment.
   Senders may call `problem` every time a check fails and `resolve` every time it passes. In a
   host's file store a new problem is held: it is sent only if still open 10 minutes after it was
   first seen (`ALERTS_HOLD_MINUTES`), by a later `problem` or `tick`. One resolved sooner sends
   nothing at all, so a flap never reaches the group. A GitHub store (one failed run, ticked daily)
   and an outage (its sender confirms it before calling) are sent at once.
2. **Every PROBLEM is closed in its own thread.** `resolve` replies to the problem's message (and to
   its escalation in "Needs you") with the short RESOLVED line `✅ Fixed after N min`. A problem still
   open gets a STILL OPEN reply when it is escalated and once a day after that.
3. **The format.** A PROBLEM says what is wrong in plain words and ends with one `You:` line
   (`--you`): `nothing`, `<who> is fixing it`, or `Needs you: <exact step>`; any other value is
   refused. Without `--you` it is `nothing` in a silent topic. An escalation ends with the problem's
   own `Needs you:` step, or asks the owner to pass it to the project's coordinator. Messages carry no
   commands (a fix belongs to whoever does it, never to the reader), and any time in them is
   Asia/Damascus time.
4. **Escalation.** A silent problem open 3 hours is posted in "Needs you", loud, with a link to the
   original. In quiet hours it waits for 08:00, so it is heard. A problem the owner acknowledged in
   the control panel (`panel.mjs`, K025) is never escalated or reminded; a muted one not until its mute
   ends (`hush`). Its RESOLVED still goes out.
5. **Quiet hours** are 23:00-08:00 Asia/Damascus: every message is silent, "Needs you" included,
   except `--outage` (a production outage), which is always loud.
6. **Caps.** At most 5 new messages per topic per hour (10 in "Needs you"); the rest are kept and sent
   by a later tick. An outage is never capped.
7. **Capped problems** (`--max-sends N`, K035). A sender that checks the same thing every day (stale
   work, stale data) opens its problem capped: the PROBLEM, then at most one STILL OPEN reply a day
   (the owner's day) from the sender's own repeat while it stays open, N messages in all (the kit's
   senders use 3). Never escalated, never reminded by `tick`; past N it is only a line in the digest,
   marked "alerted N of N", until its RESOLVED. Not for an outage or "Needs you".
8. **Stale is never OK.** A check that reads an outside source (a job's last run, a report page, an
   API answer) and finds it older than its threshold says STALE, never OK, and opens a capped problem;
   a check that could not read the source at all says so, never "none found" (K035).
9. **Good news only as a kind (K037, superseding "never success").** Something people can use went
   live is a `good_news` line, or a line in the evening summary. Routine progress, green runs and
   technical success are never sent; they belong on the Ops board.
10. **No sender talks to Telegram directly.** Everything goes through `notify.mjs`, so the rules hold
   everywhere (audit O10).

## Senders

| Sender | Store (`ALERTS_STORE`) | Topic | Runs `tick` |
|---|---|---|---|
| hands workflows (control repo) | `github:<control repo>`: one issue per problem | `kit` | the daily drift check; `hands-alerts` when on |
| a project's workflows | `github:<the project>` | its own (kit-installed ones: the profile's `alerts.topic`) | `hands-alerts` when on, or a host |
| VPS alerts job | `file:/var/lib/harness-alerts/state.json` | `ops` (or `--outage`) | its own cron |
| home server watcher | `file:/var/lib/harness-alerts/state.json` | `ops` | its own cron |

**A project's workflow** (main-branch CI, deploy): the job grants `issues: write`, then

```yaml
      - if: failure() && github.ref == format('refs/heads/{0}', github.event.repository.default_branch)
        env:
          GH_TOKEN: ${{ github.token }}
          ALERTS_STORE: github:${{ github.repository }}
          ALERTS_BOT_TOKEN: ${{ secrets.ALERTS_BOT_TOKEN }}
          ALERTS_CHAT_ID: ${{ secrets.ALERTS_CHAT_ID }}
        run: node .harness/tools/notify.mjs problem --key "ci/${{ github.workflow }}" --topic website --title "${{ github.workflow }} failing on main" --text "${{ github.workflow }} failed on main" --link "${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}"
      - if: success() && github.ref == format('refs/heads/{0}', github.event.repository.default_branch)
        env: # the same four as above
        run: node .harness/tools/notify.mjs resolve --key "ci/${{ github.workflow }}" --text "${{ github.workflow }} green again"
```

Without the two secrets the problem is still recorded (an issue) and the next tick sends it, so a
project can adopt the standard before its secrets exist, at the cost of the tick's delay.

**A kit-installed workflow** (`harness-stale`) sends nothing to Telegram (K038): its list is the
"Stale work" issue, and with the Actions variable `ALERTS_OPS_BOARD` each item is also an Ops board row.
The profile's `alerts.topic` is still read by senders that use the older `problem` form.

**A host** (the VPS, the home server, the laptop): Node 18 or newer, the tool from a release tag, and a state file.

```sh
sudo install -d -m 700 /var/lib/harness-alerts /usr/local/lib/harness
sudo curl -fsSLo /usr/local/lib/harness/notify.mjs https://raw.githubusercontent.com/obidex/harness-kit/v0.8.0/.harness/tools/notify.mjs
# /etc/harness-alerts.env, mode 600: ALERTS_BOT_TOKEN=…  ALERTS_CHAT_ID=…  ALERTS_STORE=file:/var/lib/harness-alerts/state.json
notify() { ( set -a; . /etc/harness-alerts.env; node /usr/local/lib/harness/notify.mjs "$@" ); }
notify problem --key vps/disk --topic ops --text "VPS disk 93% full" --you nothing   # each failing check
notify problem --key vps/site-down --outage --text "website not answering" # a production outage
notify resolve --key vps/disk --text "disk 71%"                              # each passing check
# crontab: */10 * * * * set -a; . /etc/harness-alerts.env; node /usr/local/lib/harness/notify.mjs tick
```

Keys are stable names per check (`vps/disk`, `server/backup`), never containing a time or a number
that changes, or deduplication cannot work.

## Ticking: who runs the clock

Escalation, STILL OPEN replies and held messages need a periodic `tick` over each store.

- **Hosts** tick their own file store from cron, every 10 minutes: free.
- **The control repository** ticks its own issues once a day in the drift check (no extra job), and
  posts the digest there.
- **`hands-alerts`** ticks every enrolled repository hourly, 08:00-22:00 Damascus, only when the
  Actions variable `ALERTS_TICK` is `on`: about 450 GitHub-hosted minutes a month (O13).
- **Or a host ticks GitHub too**, for free: `tick --stores file:<its state>,github:owner/a,github:owner/b` with a
  fine-grained token (Issues: read and write on those repositories) as `GH_TOKEN`.

Without one of the last two, a GitHub-side problem is escalated at the next morning's daily run, not
after 3 hours.

## Setup (once)

1. The owner creates the group, turns on Topics, adds the bot as an admin that can manage topics and
   pin messages (the batch in the thread that introduced this).
2. Dispatch `hands-alerts` with mode `find`: it names the bot behind `TELEGRAM_BOT_TOKEN` (the
   `hands` environment) and the groups it was added to, with their ids. The group's id (it starts
   with `-100`) goes in the file `ALERTS_CHAT_ID` at the control repository's root, by PR; it is not a
   secret, and it wins over the older `TELEGRAM_CHAT_ID`. Until then alerts still reach that older
   chat, unthreaded, each led by its topic's name.
3. Dispatch `hands-alerts` with mode `setup`: it refuses a group without Topics or a bot without the
   rights, else creates the topics and pins the config. Then mode `test`: one PROBLEM and its RESOLVED
   reply in "Kit & Hands".
4. Each host and project gets the token and chat id as above.

## Cost (O13)

| What | Where | Minutes a month |
|---|---|---|
| `hands-report` alerting | control repo, inside the report job that already runs | 0 extra |
| resolve, tick and digest in the drift check | control repo, two steps in the daily job | 0 extra jobs |
| `hands-alerts` dispatches | control repo | ~1 per dispatch |
| `hands-alerts` hourly tick | control repo, only with `ALERTS_TICK=on` | ~450 |
| a project's problem and resolve steps | inside the project's own jobs | 0 extra jobs |
| hosts | the VPS, the home server | none (not GitHub) |

Telegram's Bot API is free. A GitHub store is issues, which are not metered.
