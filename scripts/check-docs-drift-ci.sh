#!/usr/bin/env bash
#
# check-docs-drift-ci.sh — CI variant of the doc-drift guard.
# Fails when a branch changes drift-prone source files without touching
# any user-facing docs in the same diff.

set -euo pipefail

SOURCE_DRIFT_PATTERNS=(
  '^packages/proxy/src/cli\.ts$'
  '^packages/proxy/src/config/schema\.ts$'
  '^packages/proxy/src/config/loader\.ts$'
  '^packages/proxy/src/dashboard/api\.ts$'
  '^packages/proxy/src/evidence/api\.ts$'
  '^packages/proxy/src/approval/.*\.ts$'
  '^packages/proxy/src/audit/csv\.ts$'
  '^packages/proxy/src/audit/store\.ts$'
  '^packages/proxy/src/policy/.*\.ts$'
  '^packages/proxy/src/transport/.*\.ts$'
  '^packages/proxy/src/upstream/.*\.ts$'
  '^packages/proxy/scripts/benchmark\.ts$'
  '^packages/python-sdk/src/helio/__init__\.py$'
  '^packages/python-sdk/src/helio/client\.py$'
  '^packages/python-sdk/src/helio/context\.py$'
  '^packages/python-sdk/src/helio/types\.py$'
  '^docker/docker-compose\.yml$'
  '^docker/helio\.docker\.yaml$'
  '^docker/Dockerfile$'
)

DOC_PATTERNS=(
  '^README\.md$'
  '^CONTRIBUTING\.md$'
  '^SECURITY\.md$'
  '^CODE_OF_CONDUCT\.md$'
  '^DEPENDENCIES\.md$'
  '^docs/.*\.md$'
  '^packages/proxy/README\.md$'
  '^packages/dashboard/README\.md$'
  '^packages/python-sdk/README\.md$'
  '^docker/README\.md$'
  '^examples/.*/README\.md$'
)

match_any() {
  local file="$1"
  local arr_name="$2"
  local pat
  eval "local arr=(\"\${${arr_name}[@]:-}\")"
  for pat in "${arr[@]:-}"; do
    if [[ "$file" =~ $pat ]]; then
      return 0
    fi
  done
  return 1
}

base_ref="${1:-}"
if [[ -z "$base_ref" ]]; then
  if [[ -n "${GITHUB_BASE_REF:-}" ]]; then
    base_ref="origin/${GITHUB_BASE_REF}"
  else
    base_ref="HEAD~1"
  fi
fi

if ! git rev-parse --verify "$base_ref" >/dev/null 2>&1; then
  echo "[docs-check] Base ref '$base_ref' not found; skipping docs drift check."
  exit 0
fi

changed=$(
  git -c core.quotePath=false diff --name-only --diff-filter=ACMR "$base_ref"...HEAD || true
)

if [[ -z "$changed" ]]; then
  exit 0
fi

touched_source=()
touched_doc=()

while IFS= read -r file; do
  [[ -z "$file" ]] && continue
  if match_any "$file" SOURCE_DRIFT_PATTERNS; then
    touched_source+=("$file")
  fi
  if match_any "$file" DOC_PATTERNS; then
    touched_doc+=("$file")
  fi
done <<<"$changed"

if [[ ${#touched_source[@]} -eq 0 ]]; then
  exit 0
fi

if [[ ${#touched_doc[@]} -gt 0 ]]; then
  exit 0
fi

{
  echo ""
  echo "════════════════════════════════════════════════════════════════════"
  echo "  📚  DOC DRIFT CHECK (CI) — source changed without docs"
  echo "════════════════════════════════════════════════════════════════════"
  echo ""
  echo "Changed source files that commonly drift docs:"
  for f in "${touched_source[@]}"; do
    echo "  • $f"
  done
  echo ""
  echo "Add user-facing docs in the same PR/commit (docs/*.md, README, etc.)."
  echo ""
} >&2

exit 1
