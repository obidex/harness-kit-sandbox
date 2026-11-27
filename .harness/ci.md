# Harness Kit · CI speed: chores apart, one chore run per burst, checks scaled to the change

> Lookup only, never loaded. K059. What a project does so a chore of seconds never waits behind a test
> of minutes, a burst of comments costs one run, and a change is checked as much as it can matter,
> with a full run every night as the net. Nothing here removes or weakens a required check.

Measured on one busy day (K059): about 92 runs waiting across the projects, 11 of them real tests;
half of the rest were the attribution scrubber, one run per comment, each 6 to 25 seconds of work that
waited 5 to 38 minutes behind 13-minute test jobs on the same single runner.

## 1. Two lanes: chores apart from tests

Every short kit job (`harness-scrub`, `-guard`, `-audit`, `-inbox`, `-review`, `-rerun`, `-stale`, `-wake`) runs
on `${{ vars.CHORE_RUNNER || vars.RUNNER || 'ubuntu-latest' }}`. The long `harness-sweep` stays on
`RUNNER`. With no lane set nothing changes.

**Where the lane is set (K063): the profile, a reviewed change.** GitHub picks a job's runner before any
step runs, so a workflow cannot read a file for its `runs-on`; the kit writes the setting in when it
installs its workflows instead. `.harness/profile.json` `"chore_runner": "chores"` installs every chore
job as `${{ (vars.CHORE_RUNNER || 'chores') || vars.RUNNER || 'ubuntu-latest' }}`: the file decides, and
the Actions variable `CHORE_RUNNER`, when set, overrides it. To change it, edit the profile and run
`node .harness/tools/harness.mjs lanes` in the same pull request (it rewrites the kit workflows and the
lock); `harness.mjs status` and the audit (A04) fail while the two disagree, and every kit update or
rollback writes the profile's lane by itself. Before rolling back below 0.56.0 (which knows no lane and
whose schema refuses the key), remove `chore_runner` and run `lanes` first. Removing `chore_runner` and running `lanes` puts the
templates back byte for byte. No settings page and no owner step.

To open the lane on a self-hosted machine (a root step for the machine's own project, which owns its
runners): register one more runner process for the repository with **only** the chore label, so it
takes nothing else and the test runners never take a chore:

```sh
./config.sh --url https://github.com/<owner>/<repo> --token <registration token> \
  --name <host>-chores --no-default-labels --labels chores --unattended
```

then set `chore_runner` to `chores` in the profile and run `harness.mjs lanes` (above), in a pull
request. Check the machine first: a chore process needs little (each job is a sparse checkout and one
Node script), but its work folder and logs take disk. If the chore runner is offline, chores wait: a
pull request that removes `chore_runner` falls back to `RUNNER`, but its own chore checks wait for the
same runner, so the quick way back is the variable, set to the test runner's label (it overrides the
file). A public repository sets no lane, in the profile or a variable (A19 fails it: anyone could queue
jobs on the machine by commenting); GitHub-hosted minutes are free there.

A private repository with no self-hosted runner runs its chores on GitHub-hosted minutes. Section 2
cuts that count most; the rest is moving it onto a chore lane.

## 2. One chore run per burst

`harness-scrub` has one concurrency group for the repository's issues and comments: at most one run
going and one waiting, and GitHub drops the older waiting run when a newer one arrives. A pull
request's own events (opened, edited, a review) keep one group per pull request, as before, so a
comment never leaves a cancelled scrub check on a pull request's head commit. Each run cleans its own
event's body and then sweeps every issue, pull request, comment and review comment updated since the
newest earlier run that finished green (less 5 minutes; at most the last day), and the reviews of the
pull requests among them (`scrub.mjs sweep`). A dropped run's body is cleaned by the run that replaced
it. Only a green run made from the current workflow file counts (one older than the file's last
change ran a file that may not have swept), so the first run after a kit update sweeps the last day:
waiting scrub runs may be cancelled while an update is on its way. A listing longer than 3,000 items, or any error but a body that is read-only or gone, fails the
run, so the next one sweeps again from the last green run. A GitHub hiccup is tried three times first
(every read of the kit's tools, `lib.mjs` `ghCall`, K075). A pull request's own run is that pull
request's check: once its own body is read clean, a sweep that still fails is a warning and the check
stays green, so such a run never anchors the window; the next run from an issue or comment does, and it
fails when its sweep fails. A fork's or Dependabot's pull-request event has a read-only token, so it keeps a group of its own
and sweeps nothing. `harness-audit` and `harness-guard` already keep one run per pull request
(`cancel-in-progress`).

## 3. Checks scaled to the change, with a full run every night

A project's own CI stays its own; the kit gives it the rule (`.harness/tools/scope.mjs`, tested by
the kit) and this pattern. The required check is the last job, `ci-ok`, which always runs and passes
only when every job it needs passed, or, on a light run, was skipped. No required check is removed.

- **light**: every changed path is a document (Markdown, or a named notice file such as `LICENSE` or
  `README.txt`; never another `.txt` or `.rst`, which may be `requirements.txt` or a Sphinx page)
  outside the paths a build or a test may read (`ci_scope.full` in the profile; by default `src/`,
  `app/`, `pages/`, `content/`, `public/`, `lib/`, `supabase/`, `packages/`, and every test, fixture
  and test-data folder). A documentation site found in the checkout (MkDocs, Docusaurus, Sphinx,
  VitePress: `docs/` and `blog/`; Jekyll or mdBook: every Markdown file) makes its pages full; a site
  the tool does not know goes in `ci_scope.full`. Runs the secret scan and the guards (the kit's own
  workflows, always), and the project's lint.
- **full**: anything else; every push to the default branch; the nightly run; a run by hand; any
  doubt (an unreadable diff, an empty one). `tier3=true` when a path is high-risk (C09; the profile's
  `risk.tier3_paths` and agent configuration), which a project uses to start its reviewers.
- The scope tool and the gate run from the base branch, so a pull request cannot make itself light by
  changing them; a pull request that changes the profile or a workflow is itself full.
- A workflow with no `schedule` never runs light: the nightly full run is the net under every light
  pull request, and the scope tool reads the calling workflow to make sure it exists.

```yaml
name: ci
on:
  pull_request:
  push:
    branches: [main]
  schedule:
    - cron: '17 1 * * *'        # the nightly full run on the default branch
  workflow_dispatch:
permissions:
  contents: read
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
jobs:
  scope:
    runs-on: ${{ vars.RUNNER || 'ubuntu-latest' }}
    timeout-minutes: 3
    outputs:
      level: ${{ steps.s.outputs.level }}
      tier3: ${{ steps.s.outputs.tier3 }}
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0
          persist-credentials: false
      - name: The rule comes from the base branch, never from the pull request it judges
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          ref: ${{ github.event.pull_request.base.sha || github.sha }}
          path: base
          sparse-checkout: .harness/tools
          persist-credentials: false
      - id: s
        run: node base/.harness/tools/scope.mjs decide
  lint:
    needs: scope
    runs-on: ${{ vars.RUNNER || 'ubuntu-latest' }}
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - run: npm ci && npm run lint
  test:
    needs: scope
    if: needs.scope.outputs.level == 'full'
    runs-on: ${{ vars.RUNNER || 'ubuntu-latest' }}
    timeout-minutes: 20
    strategy:
      fail-fast: false
      matrix:
        shard: [1, 2, 3]
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version: 22
          cache: npm
      - run: npm ci && npm test -- --shard=${{ matrix.shard }}/3
  ci-ok:
    needs: [scope, lint, test]
    if: always()
    runs-on: ${{ vars.CHORE_RUNNER || vars.RUNNER || 'ubuntu-latest' }}
    timeout-minutes: 3
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          ref: ${{ github.event.pull_request.base.sha || github.sha }}
          sparse-checkout: .harness/tools
          persist-credentials: false
      - env:
          RESULTS: ${{ toJSON(needs) }}
          LEVEL: ${{ needs.scope.outputs.level }}
        run: node .harness/tools/scope.mjs gate
```

`ci-ok` must need every job of the workflow directly: it judges only the jobs it names, so a job left
out of its `needs` could fail unseen.

Make `ci-ok` the required check (in `.github/harness-settings.json`) before the old per-job checks
leave the list, in the same settings change, so the gate is never open in between. A failed nightly
run is a red default branch (C13): the next card, and only fix PRs until it is green. GitHub stops a
public repository's schedules after 60 days without activity; the stale check's missed-run rows
(`stale.mjs schedules`) are what notice it.

## 4. Split the long test job

One job of 13 to 24 minutes is the queue's longest wait. Split it into parts that run side by side:
a test runner's own sharding (`--shard=i/n` in Vitest, Jest and Playwright), or one job per suite
(unit, database, browser). Parts run in parallel only where there is a runner process free for each;
on a single runner they run one after another and save nothing but a clearer failure. A project adds
runner processes for its test lane (same labels as its `RUNNER`) where the machine has processors and
memory to spare, and checks the machine first.

Keep what can be kept between runs: on GitHub-hosted runners `setup-node`'s `cache: npm`; on a
self-hosted runner the npm cache and Playwright's browsers already stay in the runner user's home
between jobs, so do not wipe them in a step.

## 5. The finish line (per project, at the level of a bulk-work day)

A chore finishes within 2 minutes of its event; a test run starts within 5 minutes; a documents-only
change is checked in under 3 minutes; the nightly full run is green; no required check was removed;
the month's GitHub-hosted minutes stay inside the plan's allowance (the billing page; O13).
