#!/usr/bin/env bash
#
# Generate a release SBOM for one workspace package and refuse an empty
# or mis-scoped one.
#
# The document is CycloneDX 1.6 JSON written by `pnpm sbom` from
# pnpm-lock.yaml, scoped to the package's production dependency tree
# as the lockfile pins it. For the proxy that is the tree CI tests at
# the tag and the tree docker/Dockerfile installs; for the dashboard
# it is the tree the static bundle the proxy serves is built from
# (the tree, not the bundle's bytes). The checks exist because the
# proxy's asset shipped empty for three releases without anything
# noticing (issue #349); the dashboard's asset gets the same checks
# from its first release (issue #365).
#
# Usage: scripts/generate-sbom.sh <package-dir> <output-file> [expected-version]
#   package-dir is a directory under packages/ (proxy or dashboard).
#   expected-version defaults to that package.json's version.
#   The release workflow passes the tag's version after
#   scripts/set-release-version.sh has stamped it.

set -euo pipefail

ROOT_DIR="$(git rev-parse --show-toplevel)"
PACKAGE_DIR="${1:?usage: $0 <package-dir> <output-file> [expected-version]}"
OUT="${2:?usage: $0 <package-dir> <output-file> [expected-version]}"
MANIFEST="${ROOT_DIR}/packages/${PACKAGE_DIR}/package.json"

fail() {
  echo "SBOM CHECK FAIL: $1" >&2
  exit 1
}

[[ -f "${MANIFEST}" ]] || fail "no package manifest at ${MANIFEST}"
PACKAGE_NAME="$(jq -r .name "${MANIFEST}")"
EXPECTED_VERSION="${3:-$(jq -r .version "${MANIFEST}")}"
EXPECTED_PURL="pkg:npm/${PACKAGE_NAME/@/%40}@${EXPECTED_VERSION}"

cd "${ROOT_DIR}"
rm -f "${OUT}"
pnpm sbom --sbom-format cyclonedx --sbom-spec-version 1.6 \
  --sbom-type application --prod --filter "${PACKAGE_NAME}" \
  --fail-if-no-match --out "${OUT}"
[[ -f "${OUT}" ]] || fail "pnpm sbom wrote no file at ${OUT}"

count="$(jq '.components | length' "${OUT}")"
[[ "${count}" -gt 0 ]] || fail "components is empty"

purl="$(jq -r '.metadata.component.purl // ""' "${OUT}")"
[[ "${purl}" == "${EXPECTED_PURL}" ]] \
  || fail "metadata.component.purl is '${purl}', expected '${EXPECTED_PURL}'"

while IFS=$'\t' read -r name version; do
  jq -e --arg n "${name}" --arg v "${version}" '
    [.components[]
     | select(((.group // "") + (if .group then "/" else "" end) + .name) == $n
              and .version == $v)]
    | length == 1' "${OUT}" >/dev/null \
    || fail "direct dependency ${name}@${version} is not listed exactly once"
done < <(jq -r '.dependencies | to_entries[] | "\(.key)\t\(.value)"' "${MANIFEST}")

unlicensed="$(jq '[.components[] | select(.licenses == null)] | length' "${OUT}")"
[[ "${unlicensed}" -eq 0 ]] \
  || fail "${unlicensed} components carry no license (was the store populated before pnpm sbom?)"

echo "SBOM OK: ${purl}, ${count} components, every direct dependency listed once, all licensed"
