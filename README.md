# Terraform Plan Colors

Colorizes saved `terraform plan` output text files (e.g. `2026.5.7.2230.tfplan`,
`plan-2026.5.7.2230.txt`, `prod.tfplan.txt`).

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

Files with a `.tfplan` extension, or matching `*plan*.txt` or `*.tfplan.txt`,
get the `Terraform Plan` language. `.tfplan` is recommended: `.txt` files keep
the icon theme's text-file icon, while `.tfplan` files show this extension's
own file icon.
Plain `.txt` files are also content-sniffed (first lines starting with
`Terraform used the selected providers...`). You can always set the language
manually to `Terraform Plan`.

## Install (local, no marketplace)

Symlink the repo into your editor's extensions directory, from the repo root:

**VSCode:**

```sh
ln -s "$(pwd)" ~/.vscode/extensions/lite2073.tfplan-colors
```

**Antigravity:**

```sh
ln -s "$(pwd)" ~/.antigravity-ide/extensions/lite2073.tfplan-colors
```

Then reload the editor (`Developer: Reload Window`).

To develop: open this folder in VSCode and press F5 (Extension Development Host).

## Publish

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
