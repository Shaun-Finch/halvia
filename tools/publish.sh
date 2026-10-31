#!/usr/bin/env bash
# Publish result files to bot-lab from a separate clone, so the checkout under test is never touched
# and concurrent writers can't leave a half-finished rebase. Usage: MSG="..." tools/publish.sh path...
set -u
D=/tmp/publish
[ -d "$D" ] || git clone -q --depth 5 -b bot-lab "https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git" "$D"
git -C "$D" config user.name "github-actions[bot]"
git -C "$D" config user.email "41898282+github-actions[bot]@users.noreply.github.com"
for i in 1 2 3 4 5; do
  git -C "$D" fetch -q origin bot-lab && git -C "$D" reset -q --hard origin/bot-lab
  for p in "$@"; do mkdir -p "$D/$(dirname "$p")"; cp -r "$p" "$D/$(dirname "$p")/"; done
  git -C "$D" add "$@"
  git -C "$D" commit -qm "${MSG:-Results}" || exit 0
  git -C "$D" push -q origin HEAD:bot-lab && exit 0
  sleep $((i * 3))
done
