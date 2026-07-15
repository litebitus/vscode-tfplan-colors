## 1.6.0 (2026-07-15)

- feat: color terraform line-diff markers inside updated heredocs

## 1.5.6 (2026-07-14)

- fix: refresh tree and retry once when summary reveal hits a dropped widget node

## 1.5.5 (2026-07-13)

- fix: generation-scoped summary tree item ids to stop stale widget state across plans

## 1.5.4 (2026-07-11)

- fix: match resource addresses with arbitrary map keys

## 1.5.3 (2026-07-10)

- fix: match resource addresses with wildcards in map keys

## 1.5.2 (2026-07-09)

- fix: match resource addresses with colons in map keys

## 1.5.1 (2026-07-09)

- fix: close diff-suffixed heredoc terminators; materialize summary tree with stable element identity

## 1.5.0 (2026-07-07)

- feat: sync plan summary selection with editor position; leveled debug logging

## 1.4.4 (2026-07-07)

- fix: don't classify heredoc string content as diff markers or headers

## 1.4.3 (2026-07-06)

- fix: key summary refresh suppression on document instance, not uri+version

## 1.4.2 (2026-07-06)

- fix: per-document debounce so chatty documents can't drop summary refreshes
- test: run integration suite against the 1.85 engines floor and stable

## 1.4.1 (2026-07-06)

- fix: stable tree item ids and refresh suppression for plan summary; test duplicate-name nesting

## 1.4.0 (2026-07-06)

- feat: show terraform's Plan summary line atop the summary view

## 1.3.2 (2026-07-06)

- test: integration coverage for flash guard and find-widget selections
- fix: don't flash or steal focus on find-widget selection changes

## 1.3.1 (2026-07-05)

- fix: hide plan summary view when all plan editors close

## 1.3.0 (2026-07-05)

- feat: nest summary resources under module chains; refresh tagline and intro

## 1.2.0 (2026-07-04)

- feat: plan summary sidebar view grouped by action severity, with integration tests

## 1.1.0 (2026-07-03)

- fix: rename rendered previews to dodge custom editor claims; gate package on test-all
- test: integration tests for navigation resolution and status bar; document manual checklist
- feat: module-nested outline, folding-based sticky scroll, status bar address, plan-language auto-promotion, editor defaults; fix text plan outline navigation

## 1.0.0 (2026-07-03)

- feat: extract parsing into lib.js with test suite; fix forget-header classification
- feat: auto-refresh plan preview, uninstall target, diagnostics logging
- feat: render binary plans via terraform show, save rendered plan as text

## 0.1.6 (2026-07-03)

- docs: add usage example; mention .tfplan in description

## 0.1.5 (2026-07-03)

- feat: auto-generate changelog on version bump
- docs: update README for .tfplan variants and make-based publishing

## 0.1.4 (2026-07-03)

- feat: preflight checks git tree, vsce login, and OVSX_PAT before publish

## 0.1.3 (2026-07-02)

- feat: add .tfplan file extension support
- fix: check OVSX_PAT before version bump in make publish

## 0.1.2 (2026-07-02)

- feat: add Makefile for publishing to both marketplaces
- feat: add file icon for terraform-plan language

## 0.1.1 (2026-07-02)

- feat: add marketplace icon
- chore: add publishing metadata, LICENSE, ignore files, and publish docs
- feat: initial commit
