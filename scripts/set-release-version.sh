#!/usr/bin/env bash
# Rewrites package.json versions for all npm-published workspaces.
# Called from every release job that produces a versioned npm or Docker
# artifact, so the git tag stays the single source of truth and no release
# artifact can silently ship the 0.0.0 sentinel.
#
# Usage: scripts/set-release-version.sh <version>

set -euo pipefail

VERSION="${1:?usage: $0 <version>}"

(cd packages/proxy     && npm version "$VERSION" --no-git-tag-version --allow-same-version)
