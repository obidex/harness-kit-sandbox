# Preset · web app

> A signed-in application for staff or members, backed by its own database (first user: the ERP).
> Lookup only. A profile selects it with `"preset": "web-app"`; it may add or drop capabilities
> through `capabilities` and record why under `exceptions`.

**Capabilities:** database · auth · deployments · recurring jobs · sensitive data · host/infra

**What makes it different:** the users are known and signed in, so the risk sits in permissions,
data integrity and derived figures, not in what anonymous visitors can read.

## Preset rules

- **WA01 Screens are shown, and approved first.** UI-changing work starts only after the owner has
  approved its screens visually; a change is proven by a screenshot or preview URL, never a diff; a
  screen that differs from its approved design is held while the rest is built.
- **WA02 Speed is measured.** Each speed target names its action, its device and network profile
  and its evidence; a deferred or skipped benchmark is never evidence.

| ID | Applies when | Expected outcome | Source | Verify |
|---|---|---|---|---|
| WA01 | preset web-app or public-website, a UI-changing card | The card links its approved design; the PR carries screenshots or a preview URL; mismatches were held. | ERP AGENTS §4 (GATE 0), STRATEGIST §2 · D248, D251; WEB run-card §10 | judgment: sampled UI PRs show visual evidence matching an approved design. |
| WA02 | preset web-app with speed targets in the profile | Each target has a recent measured result on its stated profile. | ERP AGENTS §7 · D266, D268 | judgment: sample targets for current measured evidence. |
