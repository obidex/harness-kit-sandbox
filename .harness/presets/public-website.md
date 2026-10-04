# Preset · public website

> A public site anonymous visitors read, optionally with a signed-in area (first user: the
> website). Lookup only. A profile selects it with `"preset": "public-website"`; it may add
> capabilities (for example host/infra when it uses self-hosted runners) and record why under
> `exceptions`.

**Capabilities:** public interface · bilingual · database · auth · deployments · recurring jobs · sensitive data

**Also binds:** WA01 (screens shown and approved first; `presets/web-app.md`).

**What makes it different:** anyone can read the output, so the risk sits in what the built pages,
bundles and APIs reveal, and in content that is unpublished or not yet approved.

## Preset rules

- **PW01 Static by default.** Pages are prerendered; on-demand rendering only on routes a card
  names.
- **PW02 Verify the built site.** Every change runs the build and a verification over its output:
  page count against the declared number, links and assets, sitemap, alternate-language links,
  structured data and the PI01 leak scan. Any FAIL stops the commit.
- **PW03 Published content only.** Every content query reads published content and excludes drafts
  and hidden records, at build and request time.

| ID | Applies when | Expected outcome | Source | Verify |
|---|---|---|---|---|
| PW01 | preset public-website | On-demand routes are exactly those named by cards. | WEB AGENTS §2, §6 · W074 | script: list routes that opt out of prerendering; compare with the profile's allowed list. |
| PW02 | preset public-website | CI runs build plus output verification on every PR, and it is required. | WEB skills/verify, run-card §4 · W020 | script: the verify step is in the required check. |
| PW03 | preset public-website with a content store | Every content query carries the published/draft guard. | WEB AGENTS §3 · W012, W077 | script: grep content queries for the guard. |
