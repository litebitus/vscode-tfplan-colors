#!/bin/sh
# Prepends a CHANGELOG.md section for the current package.json version with
# commit subjects since the previous tag. Invoked by the npm "version" hook
# (package.json), which runs after the bump but before npm's commit — the
# `git add` there folds the changelog into the version commit itself.
set -e
ver=$(node -p "require('./package.json').version")
prev=$(git describe --tags --abbrev=0 2>/dev/null || true)
tmp=$(mktemp)
{
  echo "## $ver ($(date +%Y-%m-%d))"
  echo
  if [ -n "$prev" ]; then
    git log --no-merges -E --invert-grep --grep='^[0-9]+\.[0-9]+\.[0-9]+$' --pretty='- %s' "$prev..HEAD"
  else
    git log --no-merges -E --invert-grep --grep='^[0-9]+\.[0-9]+\.[0-9]+$' --pretty='- %s'
  fi
  echo
  [ -f CHANGELOG.md ] && cat CHANGELOG.md
} > "$tmp"
mv "$tmp" CHANGELOG.md
