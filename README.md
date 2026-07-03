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
ln -s "$(pwd)" ~/.vscode/extensions/teli.tfplan-colors-0.1.0
```

**Antigravity:**

```sh
ln -s "$(pwd)" ~/.antigravity-ide/extensions/teli.tfplan-colors-0.1.0
```

Then reload the editor (`Developer: Reload Window`).

To develop: open this folder in VSCode and press F5 (Extension Development Host).
