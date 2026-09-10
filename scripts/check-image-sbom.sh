#!/usr/bin/env bash
#
# Assert that an image's SBOM attestation lists exactly the production
# dependency tree of @gethelio/proxy that pnpm-lock.yaml pins: the same
# name@version set the release sbom.json inventories and the image's
# package directories hold (scripts/check-image-inventory.sh), plus the
# proxy itself at the expected version (issue #368).
#
# Usage: scripts/check-image-sbom.sh <sbom-json> [expected-version]
#   sbom-json is what `docker buildx imagetools inspect <ref>
#   --format '{{ json .SBOM }}'` prints: {"SPDX": ...} for a
#   single-platform image, or {"linux/amd64": {"SPDX": ...}, ...} for
#   a multi-platform index. Every platform in it is checked.
#   expected-version defaults to packages/proxy/package.json's; the
#   release workflow passes the tag's version.
#
# BuildKit's syft scanner writes the attestation from the final stage's
# filesystem, so the document also lists the base image's Debian
# packages, Node, npm and its tree, the pnpm copy corepack cached, the
# versionless workspace root manifest, and any manifest syft finds
# inside a package's example or test directory.
# The comparison is on the npm packages whose manifest sits at pnpm's
# package depth, node_modules/.pnpm/<dir>/node_modules/<name>/package.json,
# which is what the image installed. Exits non-zero, naming every
# package on the wrong side, on the first difference.

set -euo pipefail

SBOM="${1:?usage: $0 <sbom-json> [expected-version]}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST="${ROOT_DIR}/packages/proxy/package.json"
PACKAGE_DEPTH='/app/node_modules/\.pnpm/[^/]+/node_modules/(@[^/]+/)?[^/]+/package\.json$'

fail() {
  echo "IMAGE SBOM FAIL: $1" >&2
  exit 1
}

[[ -f "$SBOM" ]] || fail "no file at $SBOM"
PACKAGE_NAME="$(jq -r .name "$MANIFEST")"
EXPECTED_VERSION="${2:-$(jq -r .version "$MANIFEST")}"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

(cd "$ROOT_DIR" && pnpm sbom --sbom-format cyclonedx --sbom-spec-version 1.6 \
  --sbom-type application --prod --filter "$PACKAGE_NAME" \
  --fail-if-no-match --lockfile-only --out "$tmp/lockfile-sbom.json" >/dev/null)
jq -r '.components[] | (if .group then .group + "/" else "" end) + .name + "@" + .version' \
  "$tmp/lockfile-sbom.json" | sort -u >"$tmp/expected"
[[ -s "$tmp/expected" ]] || fail "the lockfile yields no production components for $PACKAGE_NAME"

# One document per platform; a single-platform inspect has no platform key.
jq 'if type == "object" and has("SPDX") then {"the image": .} else . end' "$SBOM" >"$tmp/documents.json" 2>/dev/null \
  || fail "$SBOM is not the JSON that imagetools inspect --format '{{ json .SBOM }}' prints"
[[ "$(jq 'type == "object" and length > 0' "$tmp/documents.json")" == true ]] || fail "no SBOM attestation in $SBOM"

while IFS= read -r platform; do
  jq -e --arg p "$platform" '.[$p].SPDX.packages | type == "array"' "$tmp/documents.json" >/dev/null \
    || fail "no SPDX document for $platform in $SBOM"

  jq -r --arg p "$platform" --arg depth "$PACKAGE_DEPTH" '
    .[$p].SPDX.packages[]
    | select((.sourceInfo // "") | test($depth))
    | .name + "@" + .versionInfo' "$tmp/documents.json" | sort -u >"$tmp/actual"

  extra="$(comm -13 "$tmp/expected" "$tmp/actual")"
  missing="$(comm -23 "$tmp/expected" "$tmp/actual")"
  if [[ -n "$extra" ]]; then
    echo "$platform: in the attestation at the package depth but not in the proxy's production tree ($(wc -l <<<"$extra" | tr -d ' ')):" >&2
    sed 's/^/  /' <<<"$extra" >&2
  fi
  if [[ -n "$missing" ]]; then
    echo "$platform: in the proxy's production tree but not in the attestation ($(wc -l <<<"$missing" | tr -d ' ')):" >&2
    sed 's/^/  /' <<<"$missing" >&2
  fi
  [[ -z "$extra" && -z "$missing" ]] \
    || fail "$platform: the attestation does not list exactly the production dependency tree of $PACKAGE_NAME"

  jq -e --arg p "$platform" --arg n "$PACKAGE_NAME" --arg v "$EXPECTED_VERSION" '
    [.[$p].SPDX.packages[]
     | select(.name == $n and .versionInfo == $v
              and ((.sourceInfo // "") | endswith("/app/packages/proxy/package.json")))]
    | length == 1' "$tmp/documents.json" >/dev/null \
    || fail "$platform: $PACKAGE_NAME@$EXPECTED_VERSION is not listed exactly once from /app/packages/proxy/package.json"

  total="$(jq -r --arg p "$platform" '.[$p].SPDX.packages | length' "$tmp/documents.json")"
  echo "IMAGE SBOM OK: $platform: the $(wc -l <"$tmp/expected" | tr -d ' ') packages of $PACKAGE_NAME's production tree at the package depth, $PACKAGE_NAME@$EXPECTED_VERSION, $total packages listed in all"
done < <(jq -r 'keys[]' "$tmp/documents.json")
