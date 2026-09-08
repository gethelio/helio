#!/usr/bin/env bash
#
# Assert that a built runtime image holds exactly the production dependency
# tree of @gethelio/proxy that pnpm-lock.yaml pins: the same name@version set
# the release sbom.json inventories (scripts/generate-sbom.sh), and no other
# package. The deps stage's dev tree and the dashboard's tree must not reach
# the image (issue #366).
#
# Usage: scripts/check-image-inventory.sh <image>
#
# The expected set comes from `pnpm sbom` on the checkout, read from the
# lockfile alone (no install, no store). The actual set is the directory
# names under node_modules/.pnpm in the image, reduced to name@version
# (pnpm names each directory <name>@<version>[_<peer suffix>], with the
# scope's slash written as a plus sign). Exits non-zero, naming every
# package on the wrong side, on the first difference.

set -euo pipefail

IMAGE="${1:?usage: $0 <image>}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

fail() {
  echo "IMAGE INVENTORY FAIL: $1" >&2
  exit 1
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

(cd "$ROOT_DIR" && pnpm sbom --sbom-format cyclonedx --sbom-spec-version 1.6 \
  --sbom-type application --prod --filter @gethelio/proxy \
  --fail-if-no-match --lockfile-only --out "$tmp/sbom.json" >/dev/null)
jq -r '.components[] | (if .group then .group + "/" else "" end) + .name + "@" + .version' \
  "$tmp/sbom.json" | sort -u >"$tmp/expected"
[[ -s "$tmp/expected" ]] || fail "the lockfile yields no production components for @gethelio/proxy"

docker run --rm --entrypoint sh "$IMAGE" -c 'ls node_modules/.pnpm' \
  | grep -v -E '^(node_modules|lock\.yaml)$' \
  | sed -E 's#^(@[^@]+)@([^_]+).*$#\1@\2#; s#^([^@]+)@([^_]+).*$#\1@\2#; s#\+#/#' \
  | sort -u >"$tmp/actual" \
  || fail "could not list node_modules/.pnpm in $IMAGE"
[[ -s "$tmp/actual" ]] || fail "no package directories under node_modules/.pnpm in $IMAGE"

extra="$(comm -13 "$tmp/expected" "$tmp/actual")"
missing="$(comm -23 "$tmp/expected" "$tmp/actual")"
if [[ -n "$extra" ]]; then
  echo "in the image but not in the proxy's production tree ($(wc -l <<<"$extra" | tr -d ' ')):" >&2
  sed 's/^/  /' <<<"$extra" >&2
fi
if [[ -n "$missing" ]]; then
  echo "in the proxy's production tree but not in the image ($(wc -l <<<"$missing" | tr -d ' ')):" >&2
  sed 's/^/  /' <<<"$missing" >&2
fi
[[ -z "$extra" && -z "$missing" ]] \
  || fail "$IMAGE does not hold exactly the production dependency tree of @gethelio/proxy"

echo "IMAGE INVENTORY OK: $IMAGE holds the $(wc -l <"$tmp/expected" | tr -d ' ') packages of @gethelio/proxy's production tree and no other package"
