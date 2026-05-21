#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(git rev-parse --show-toplevel)"
CONFIG_FILE="${ROOT_DIR}/.gitleaks.toml"
TMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

if [[ ! -f "${CONFIG_FILE}" ]]; then
  echo "Secret scan config not found: ${CONFIG_FILE}" >&2
  exit 1
fi

TRACKED_FILES="$(git ls-files)"
if [[ -z "${TRACKED_FILES}" ]]; then
  exit 0
fi

while IFS= read -r file; do
  [[ -z "${file}" ]] && continue
  mkdir -p "${TMP_DIR}/$(dirname "${file}")"
  git show ":${file}" >"${TMP_DIR}/${file}"
done <<<"${TRACKED_FILES}"

run_gitleaks() {
  local scan_source="$1"

  if command -v gitleaks >/dev/null 2>&1; then
    gitleaks detect \
      --no-git \
      --source "${scan_source}" \
      --config "${CONFIG_FILE}" \
      --redact \
      --exit-code 1
    return $?
  fi

  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    docker run --rm \
      -v "${scan_source}:/scan:ro" \
      -v "${CONFIG_FILE}:/config/gitleaks.toml:ro" \
      zricethezav/gitleaks:v8.24.2 \
      detect \
      --no-git \
      --source /scan \
      --config /config/gitleaks.toml \
      --redact \
      --exit-code 1
    return $?
  fi

  echo "Unable to run secret scan: install gitleaks or start Docker." >&2
  echo "Install examples:" >&2
  echo "  brew install gitleaks" >&2
  echo "  or use Docker Desktop" >&2
  return 1
}

run_gitleaks "${TMP_DIR}"
