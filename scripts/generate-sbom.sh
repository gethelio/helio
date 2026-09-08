#!/usr/bin/env bash
#
# Generate the release SBOM for @gethelio/proxy and refuse an empty or
# mis-scoped one.
#
# The document is CycloneDX 1.6 JSON written by `pnpm sbom` from
# pnpm-lock.yaml, scoped to the proxy package's production tree: the
# tree CI tests at the tag and the tree docker/Dockerfile installs. The
# checks exist because the asset shipped empty for three releases
# without anything noticing (issue #349).
#
# Usage: scripts/generate-sbom.sh <output-file> [expected-version]
#   expected-version defaults to packages/proxy/package.json's version.
#   The release workflow passes the tag's version after
#   scripts/set-release-version.sh has stamped it.

set -euo pipefail

ROOT_DIR="$(git rev-parse --show-toplevel)"
OUT="${1:?usage: $0 <output-file> [expected-version]}"
MANIFEST="${ROOT_DIR}/packages/proxy/package.json"
EXPECTED_VERSION="${2:-$(jq -r .version "${MANIFEST}")}"
EXPECTED_PURL="pkg:npm/%40gethelio/proxy@${EXPECTED_VERSION}"

fail() {
  echo "SBOM CHECK FAIL: $1" >&2
  exit 1
}

cd "${ROOT_DIR}"
rm -f "${OUT}"
pnpm sbom --sbom-format cyclonedx --sbom-spec-version 1.6 \
  --sbom-type application --prod --filter @gethelio/proxy \
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
