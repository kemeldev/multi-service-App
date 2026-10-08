#!/usr/bin/env bash
# Rewrites `uses: owner/repo@tag` to `uses: owner/repo@<sha> # tag`
set -euo pipefail

for f in .github/workflows/*.yml; do
  grep -oE 'uses: [A-Za-z0-9_.-]+/[A-Za-z0-9_./-]+@[A-Za-z0-9_.-]+' "$f" | sort -u |
  while read -r _ ref; do
    action="${ref%@*}"
    version="${ref#*@}"
    [[ "$version" =~ ^[0-9a-f]{40}$ ]] && continue
    repo=$(echo "$action" | cut -d/ -f1-2)
    sha=$(gh api "repos/$repo/commits/$version" --jq .sha)
    echo "$f: $action@$version -> $sha"
    sed -i -E "s|uses: ${action}@${version}([[:space:]]*)$|uses: ${action}@${sha} # ${version}|" "$f"
  done
done
