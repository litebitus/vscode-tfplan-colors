# Terraform Plan Colors

Colorizes saved `terraform plan` output — text files (e.g. `2026.5.7.2230.tfplan`,
`plan-2026.5.7.2230.txt`, `prod.tfplan.txt`) and binary plans, rendered on open
via `terraform show`.

```sh
terraform plan -out=tfplan
# open the binary tfplan directly — the extension renders it via
# `terraform show` into a colorized readonly preview

# or save a text snapshot yourself...
terraform show -no-color tfplan > $(date +%Y.%-m.%-d.%H%M).tfplan
# ...or use "Save Rendered Plan As…" from the preview;
# the text plan is colorized too — commit it for record if desired
```

## Colors

| Marker | Action | Color |
|--------|--------|-------|
| `+` | create | green |
| `~` | update in-place | yellow |
| `-` | destroy | red |
| `-/+` / `+/-` | destroy and create replacement | magenta |
| `<=` | read (data resources) | grey |
| `.` | no longer managed (forget) | grey italic |

Extras:
- Resource header lines (`# module.x.aws_y.z will be created`) are bold in the action color.
- `# forces replacement` is highlighted red inside changed attribute lines.
- Gutter bars per action color, plus overview-ruler (scrollbar) marks.

## Navigation

Each resource block becomes a document symbol:
- **Outline view** — clickable list of all resources with `+ ~ - -/+ <=` prefixes
- **Ctrl/Cmd+Shift+O** — jump to any resource by fuzzy address
- **Breadcrumbs / sticky scroll** — show the current resource while scrolling
- `Changes to Outputs` and the final `Plan: N to add...` line are symbols too.

Folding works off indentation, so resource bodies are collapsible.

## File detection

Files matching `*tfplan*` (any name containing it), `*plan*.txt`, or
`*.tfplan.txt` get the `Terraform Plan` language. `.tfplan` is recommended: `.txt` files keep
the icon theme's text-file icon, while `.tfplan` files show this extension's
own file icon.
Plain `.txt` files are also content-sniffed (first lines starting with
`Terraform used the selected providers...`). You can always set the language
manually to `Terraform Plan`.

## Binary plans

Opening a *binary* plan (`terraform plan -out=...`, detected by zip magic
bytes in any `*tfplan*` file) renders it through `terraform show -no-color`
into a readonly colorized preview instead of VSCode's "file is binary" notice.
This requires `terraform` on PATH and works when the plan file sits inside its
stack folder (an initialized working directory — the normal case); otherwise
the preview shows terraform's error. Text `*tfplan*` files open as regular
text documents, unaffected.

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

## Local testing

First remove any installed copy — with equal versions it's undefined which
copy the editor loads:

1. Quit the editors (a running editor can rewrite the extension registry
   from memory).
2. Run `make uninstall` — wipes the extension from VSCode and Antigravity.
3. Relaunch the editors.

Then build the package and install it from the Extensions view:

```sh
make package   # produces tfplan-colors.vsix
```

Extensions view → `⋯` menu → **Install from VSIX…** → pick `tfplan-colors.vsix`,
then reload the editor.

For quick iteration without installing: open this folder in VSCode and press
F5 (Extension Development Host).
