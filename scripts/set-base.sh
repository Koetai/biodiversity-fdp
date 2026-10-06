#!/bin/bash
# Point every URI in fdp/ at a different GitHub repository / branch.
# Usage: scripts/set-base.sh <org> <repo> [branch]
set -euo pipefail
cd "$(dirname "$0")/.."

[ $# -ge 2 ] || { echo "usage: $0 <org> <repo> [branch]" >&2; exit 1; }
ORG=$1 REPO=$2 BRANCH=${3:-main}

OLD=$(grep -ohE 'https://raw\.githubusercontent\.com/[^/]+/[^/]+/[^/]+/fdp/' fdp/biodiversity-index/catalog.ttl | head -1)
NEW="https://raw.githubusercontent.com/$ORG/$REPO/$BRANCH/fdp/"
[ "$OLD" != "$NEW" ] || { echo "Already using $NEW"; exit 0; }

find fdp -name '*.ttl' -print0 | xargs -0 perl -pi -e "s#\Q$OLD\E#$NEW#g"
perl -pi -e "s#^github\.org=.*#github.org=$ORG#; s#^github\.repo=.*#github.repo=$REPO#; s#^github\.branch=.*#github.branch=$BRANCH#" \
  viewer/config.properties.template

echo "Rebased $OLD -> $NEW"
python3 scripts/validate.py | tail -2
