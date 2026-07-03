# Publishing:
#   make publish              # bump patch, publish to Open VSX + VS Code Marketplace
#   make publish BUMP=minor   # bump minor instead
#
# Prerequisites (one-time):
#   vsce login lite2073       # VS Code Marketplace PAT
#   export OVSX_PAT=...       # Open VSX token (ovsx reads this env var)

BUMP ?= patch
VSIX = tfplan-colors.vsix

.PHONY: package publish preflight bump publish-ovsx publish-vsce

package:
	vsce package -o $(VSIX)

# Bump first (commit + tag, requires clean tree), then publish one identical
# .vsix to both stores. Open VSX goes first because it returns quickly; the
# MS marketplace step can hang on validation polling — if it does, the upload
# usually succeeded and Ctrl+C is safe (verify with: vsce show lite2073.tfplan-colors).
# preflight runs before bump so a missing token can't strand a bumped version.
publish: preflight bump publish-ovsx publish-vsce

preflight:
ifndef OVSX_PAT
	$(error OVSX_PAT is not set — export your Open VSX token first)
endif

bump:
	npm version $(BUMP)

publish-ovsx: package preflight
	ovsx publish $(VSIX)

publish-vsce: package
	vsce publish --packagePath $(VSIX)
