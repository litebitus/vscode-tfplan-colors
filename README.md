# Terraform Plan Colors

Colorizes saved `terraform plan` output — both binary and text plans — with
action colors and gutter bars, a severity-ordered Plan Summary sidebar, and
module-nested outline navigation.

```sh
terraform plan -out=tfplan
# open the binary tfplan directly — the extension renders it via
# `terraform show` into a colorized readonly preview

# or save a text snapshot yourself...
terraform show -no-color tfplan > $(date +%Y.%-m.%-d.%H%M).tfplan
# ...or use "Save Rendered Plan As…" from the preview;
# the text plan is colorized too — commit it for record if desired
```

- [Colors](#colors)
- [Navigation](#navigation)
  - [Plan Summary view](#plan-summary-view)
  - [Resource address in the status bar](#resource-address-in-the-status-bar)
  - [Editor defaults](#editor-defaults)
- [File detection](#file-detection)
- [Binary plans](#binary-plans)
- [Publish](#publish)
- [Development](#development)
  - [Tests](#tests)
  - [Manual test checklist](#manual-test-checklist)

## Colors

| Marker | Action | Color |
|--------|--------|-------|
| `+` | create | green |
| `~` | update in-place | yellow |
| `-` | destroy | red |
| `-/+` / `+/-` | destroy and create replacement | magenta |
| `<=` | read (data sources) | grey |
| `.` | no longer managed (forget) | grey italic |

Extras:
- Resource header lines (`# module.x.aws_y.z will be created`) are bold in the action color.
- `# forces replacement` is highlighted red inside changed attribute lines.
- Gutter bars per action color, plus overview-ruler (scrollbar) marks.

## Navigation

Each resource block becomes a document symbol, nested under its module chain
(`module.pipelines` → `module.ecs_service[0]` → `~ aws_ecs_service.this`):

- **Outline view** — module-grouped tree of all resources with `+ ~ - -/+ <=`
  prefixes; clicking navigates, flashes the target line, and focuses the
  editor with the cursor on the resource header.
- **Ctrl/Cmd+Shift+O** — jump to any resource by fuzzy address.
- **Breadcrumbs** — one short crumb per module level instead of a single
  truncated address (the file path is reduced to the filename to make room).
- **Sticky scroll** — pins the current resource's `#` header plus the
  `resource ... {` line while you scroll through its body, driven by the
  extension's folding ranges.
- `Changes to Outputs` and the final `Plan: N to add...` line are symbols too.

Resource blocks fold from their header line; inner attribute blocks fold too.

### Plan Summary view

A **Plan Summary** view appears in the Explorer sidebar (next to Outline)
whenever a plan document is active: resources grouped by action in severity
order — replace, destroy, create, update, read, forget — so destructive
changes surface first, with counts and color-coded icons per group.
Within each group resources nest under their module chain, keeping every
row short enough for the sidebar. Empty action groups are omitted. Clicking a resource reveals its block in the plan. Reach
it via the list icon in the editor title or `Terraform Plan: Summarize Plan`.

### Resource address in the status bar

Deeply nested addresses don't fit in sticky scroll or breadcrumbs, so the
full address of the resource at the cursor lives in the status bar
(bottom right):

- shown left-truncated (`…module.game[0].aws_x.this`) so the leaf stays visible
- **hover** for the complete untruncated address
- **click** to copy the address to the clipboard (for `terraform state`,
  `-target=...`, etc.) — also in the palette as
  `Terraform Plan: Copy Resource Address at Cursor`
- hidden while the cursor is outside any resource block

### Editor defaults

These are applied as defaults for `terraform-plan` documents only, and can be
overridden in your settings under `"[terraform-plan]"`:

| Setting | Default | Why |
|---------|---------|-----|
| `editor.wordWrap` | `on` | long header/ARN lines stay fully visible |
| `editor.stickyScroll.defaultModel` | `foldingProviderModel` | sticky pins resource headers, not the file-top umbrella |
| `editor.renderLineHighlight` | `all` | the cursor line is obvious after an outline jump |
| `breadcrumbs.filePath` | `last` | more room for module crumbs |

## File detection

Files with `tfplan` anywhere in the name (e.g. `2026.5.7.2230.tfplan`,
`prod.tfplan.txt`, `tfplan`) get the `Terraform Plan` language. `.tfplan` is
recommended: `.txt` files keep the icon theme's text-file icon, while
`.tfplan` files show this extension's own file icon.
Plain-text files with any other name are content-sniffed: when the first
lines look like plan output (`Terraform used the selected providers...`),
the document is automatically switched to the `Terraform Plan` language, so
the full feature set applies regardless of filename. You can always set the
language manually too.

## Binary plans

Opening a *binary* plan (`terraform plan -out=...`) renders it through
`terraform show -no-color` into a readonly colorized preview instead of
VSCode's "file is binary" notice. Auto-preview applies to binary-shaped
names — containing `tfplan` but not ending in `.tfplan` (e.g. `tfplan`,
`tfplan.bin`, `prod-tfplan`); the `.tfplan` extension is reserved for text
snapshots so their editors keep full text semantics. Any other `*tfplan*`
file can be previewed via right-click → **Reopen Editor With… →
Terraform Plan Preview**.
This requires `terraform` on PATH and works when the plan file sits inside its
stack folder (an initialized working directory — the normal case); otherwise
the preview shows terraform's error. Text `*tfplan*` files open as regular
text documents, unaffected.

The preview opens as a readonly `rendered-<name>.tfplan` tab and behaves
like any text plan — colors, outline navigation, sticky scroll, status bar
address all apply.

The preview auto-refreshes while open: regenerate the plan
(`terraform plan -out=...`) and the rendered view re-runs `terraform show`
once the file settles.

The rendered preview can be saved as a text snapshot via the save icon in the
editor title (or `Terraform Plan: Save Rendered Plan As…`) — the save dialog
defaults to `<timestamp>.tfplan` (e.g. `2026.7.3.1415.tfplan`) next to the
binary plan.

## Publish

Open VSX listing: https://open-vsx.org/extension/lite2073/tfplan-colors

Marketplace listing: https://marketplace.visualstudio.com/items?itemName=lite2073.tfplan-colors

One-time setup:

1. Publisher `lite2073` created at https://marketplace.visualstudio.com/manage
2. Azure DevOps PAT (https://aex.dev.azure.com → user settings → Personal access tokens):
   scope **Marketplace → Manage**, organization **All accessible organizations**
3. Open VSX token from https://open-vsx.org (profile → Access Tokens),
   exported as `OVSX_PAT` — Open VSX serves VSCode forks like Antigravity
4. `npm i -g @vscode/vsce ovsx`
5. `vsce login lite2073` (paste the PAT)

Each release:

```sh
make publish              # bump patch; publish to Open VSX + VS Code Marketplace; push tag
make publish BUMP=minor   # bump minor instead
```

To only build the .vsix without publishing: `make package`.
To retry a single store for the current version: `make publish-ovsx` / `make publish-vsce`.

## Development

First remove any installed copy — with equal versions it's undefined which
copy the editor loads:

1. Quit the editors (a running editor can rewrite the extension registry
   from memory).
2. Run `make uninstall` — wipes the extension from VSCode and Antigravity.
3. Relaunch the editors.

Then, for EVERY code change, run the full three-step cycle:

1. `make package` — builds a fresh `tfplan-colors.vsix` (and runs the tests)
2. Extensions view → `⋯` menu → **Install from VSIX…** → pick `tfplan-colors.vsix`
   (no uninstall needed — installing replaces the existing copy, even at the
   same version)
3. **Developer: Reload Window**

Skipping any step means testing stale code: the editor keeps running the old
build until reload, and an old `.vsix` silently reinstalls the previous code.
When in doubt whether a fix is actually installed, check the extension folder
(`~/.antigravity-ide/extensions/` or `~/.vscode/extensions/`) for the change.

For quick iteration without installing: open this folder in VSCode and press
F5 (Extension Development Host).

### Tests

- `make test` — unit tests (node, sub-second; also gates `make package`)
- `make test-all` — unit tests + integration tests in a real downloaded
  VSCode (cached in `.vscode-test/` after the first run)

### Manual test checklist

Some rendering behavior has no readable VSCode API and must be eyeballed
after significant changes (use a real plan file):

- **Outline click** — target line flashes briefly; editor takes focus with
  the cursor on the resource header.
- **Sticky scroll** — pins the current resource's `#` header plus the
  `resource ... {` line; no stale top line while scrolling.
- **Breadcrumbs** — one short crumb per module level; leaf resource visible.
- **Status bar** — hover shows the full untruncated address; click copies it.
- **Binary plans** — opening a binary `tfplan` renders the colorized preview;
  regenerating the plan auto-refreshes it; "Save Rendered Plan As…" offers a
  `<timestamp>.tfplan` default next to the binary.
