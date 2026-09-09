#!/usr/bin/env bash
# Rewrites package.json versions for every workspace package whose version
# reaches a release artifact: the proxy (published to npm, built into the
# Docker image) and the dashboard (not published; its version is the root
# component of the dashboard-bundle SBOM). Called from every release job
# that produces a versioned artifact, so the git tag stays the single
# source of truth and no release artifact can silently ship the 0.0.0
# sentinel.
#
# Usage: scripts/set-release-version.sh <version>

set -euo pipefail

VERSION="${1:?usage: $0 <version>}"

(cd packages/proxy     && npm version "$VERSION" --no-git-tag-version --allow-same-version)
(cd packages/dashboard && npm version "$VERSION" --no-git-tag-version --allow-same-version)
