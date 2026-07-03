# Terraform Plan Colors

Colorizes saved `terraform plan` output text files (e.g. `plan-2026.5.7.2230.txt`).

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

Files matching `*plan*.txt` or `*.tfplan.txt` get the `Terraform Plan` language.
Plain `.txt` files are also content-sniffed (first lines starting with
`Terraform used the selected providers...`). You can always set the language
manually to `Terraform Plan`.

## Install (local, no marketplace)

Symlink the repo into your editor's extensions directory, from the repo root:

**VSCode:**

```sh
ln -s "$(pwd)" ~/.vscode/extensions/lite2073.tfplan-colors-0.1.0
```

**Antigravity:**

```sh
ln -s "$(pwd)" ~/.antigravity-ide/extensions/lite2073.tfplan-colors-0.1.0
```

Then reload the editor (`Developer: Reload Window`).

To develop: open this folder in VSCode and press F5 (Extension Development Host).

## Publish

Marketplace listing: https://marketplace.visualstudio.com/items?itemName=lite2073.tfplan-colors

One-time setup:

1. Publisher `lite2073` created at https://marketplace.visualstudio.com/manage
2. Azure DevOps PAT (https://aex.dev.azure.com → user settings → Personal access tokens):
   scope **Marketplace → Manage**, organization **All accessible organizations**
3. `npm i -g @vscode/vsce`
4. `vsce login lite2073` (paste the PAT)

Each release:

```sh
vsce publish patch   # or minor/major — bumps version, packages, publishes
```

Or bump `"version"` in package.json manually and run `vsce publish`.
To only build the .vsix without publishing: `vsce package`.

For VSCode forks (Antigravity, etc.) that use Open VSX instead of the MS marketplace:

```sh
npm i -g ovsx
ovsx publish -p <open-vsx-token>   # token from open-vsx.org
```
