# Publishing:
#   make publish              # bump patch, publish to Open VSX + VS Code Marketplace
#   make publish BUMP=minor   # bump minor instead
#
# Prerequisites (one-time):
#   vsce login lite2073       # VS Code Marketplace PAT
#   export OVSX_PAT=...       # Open VSX token (ovsx reads this env var)

BUMP ?= patch
VSIX = tfplan-colors.vsix
# lazy (=) so it re-reads package.json after bump has run
VERSION = $(shell node -p "require('./package.json').version")
PUBLISHER = $(shell node -p "require('./package.json').publisher")
EXT_ID = $(PUBLISHER).$(shell node -p "require('./package.json').name")

.PHONY: package publish preflight bump push publish-ovsx publish-vsce uninstall

package:
	vsce package -o $(VSIX)

# Bump first (commit + tag, requires clean tree), then publish one identical
# .vsix to both stores. Open VSX goes first because it returns quickly; the
# MS marketplace step can hang on validation polling — if it does, the upload
# usually succeeded and Ctrl+C is safe (verify with: vsce show lite2073.tfplan-colors).
# preflight runs before bump so a missing token can't strand a bumped version.
# push runs last so tags only reach the remote for published versions, and
# pushes only the current version's tag; if the vsce step hangs and you
# Ctrl+C, run `make push` afterwards.
publish: preflight bump publish-ovsx publish-vsce push

# dirty check is stricter than npm version's own: also refuses on untracked
# files, since vsce/ovsx package the working tree and would ship them uncommitted
preflight:
	@test -z "$$(git status --porcelain)" || { git status --short; echo "error: git tree is dirty — commit or stash first"; exit 1; }
	@vsce ls-publishers 2>/dev/null | grep -qx "$(PUBLISHER)" || { echo "error: vsce is not logged in as $(PUBLISHER) — run: vsce login $(PUBLISHER)"; exit 1; }
	@test -n "$$OVSX_PAT" || { echo "error: OVSX_PAT is not set — export your Open VSX token first"; exit 1; }

bump:
	npm version $(BUMP)

push:
	git push origin HEAD "v$(VERSION)"

publish-ovsx: preflight package
	ovsx publish $(VSIX)

publish-vsce: preflight package
	vsce publish --packagePath $(VSIX)

# Strips this extension's entries from an editor's extensions.json — a wiped
# folder with a live registry entry breaks reinstall ("restart the IDE before
# reinstalling").
define CLEAN_REGISTRY_JS
const fs = require('fs');
const file = process.argv[1];
const entries = JSON.parse(fs.readFileSync(file));
const keep = entries.filter(e => !JSON.stringify(e).includes('$(EXT_ID)'));
fs.writeFileSync(file, JSON.stringify(keep));
endef
export CLEAN_REGISTRY_JS

# Remove every installed copy from VSCode and Antigravity: CLI uninstall for
# clean bookkeeping where available, wipe leftover folders (marketplace/local/
# orphaned alike), and clean each registry. Never fails if nothing is
# installed. Run with the editors closed: a running editor can rewrite
# extensions.json from memory.
uninstall:
	-code --uninstall-extension $(EXT_ID) >/dev/null 2>&1 || true
	-antigravity --uninstall-extension $(EXT_ID) >/dev/null 2>&1 || true
	rm -rf ~/.vscode/extensions/$(EXT_ID)* \
	       ~/.antigravity-ide/extensions/$(EXT_ID)*
	@for f in ~/.vscode/extensions/extensions.json \
	          ~/.antigravity-ide/extensions/extensions.json; do \
	  if [ -f "$$f" ]; then node -e "$$CLEAN_REGISTRY_JS" "$$f" || true; fi; \
	done
	@echo "wiped $(EXT_ID) from VSCode and Antigravity — restart editors before reinstalling"
