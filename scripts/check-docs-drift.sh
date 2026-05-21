#!/usr/bin/env bash
#
# check-docs-drift.sh — fail a commit that touches drift-prone source files
# without updating any user-facing documentation in the same commit.
#
# The rule: if staged changes modify a file in SOURCE_DRIFT_PATTERNS (things
# whose behavior is documented in prose somewhere) AND the same staged commit
# does NOT modify any file in DOC_PATTERNS, abort and ask the committer to
# either stage the corresponding doc update or explicitly bypass with
# `git commit --no-verify` (for cases where the change is demonstrably
# non-user-visible, e.g. a refactor or a test).
#
# This is a nudge, not a proof. It cannot detect drift that exists inside a
# single file that changes both source and prose — only drift where behavior
# shifts without any doc acknowledging it. That covers the common failure
# mode (the 2026-04-14 audit found 2 launch-blockers because docs lagged
# behind code that had already shipped).
#
# See .claude/helio_project/memory/feedback_sync_docs_with_code.md for the
# full grep-before-commit workflow that complements this check.

set -euo pipefail

# -----------------------------------------------------------------------------
# Configuration
# -----------------------------------------------------------------------------

# Regex patterns (ERE) matching source files whose changes most commonly drift
# documented behavior. Extend this list as new drift vectors emerge.
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

# Regex patterns matching files that count as "the committer updated a doc".
# A match here means the commit is exempt from the drift check — the committer
# is on record as having touched docs in the same unit of work.
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

# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------

# Return 0 if the given filename matches any regex in the given array name.
#
# NOTE: uses `eval` to dereference the array by name because `declare -n`
# (namerefs) is bash 4+ and husky hooks must work on macOS system bash 3.2.
# The `${…[@]:-}` form guards against `set -u` aborting when a caller passes
# an empty array — defensive against future maintenance that temporarily
# empties SOURCE_DRIFT_PATTERNS or DOC_PATTERNS.
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

# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------

# Collect staged files. Include A(dded), C(opied), M(odified), R(enamed) —
# we do NOT warn on deletion-only commits because those tend to be cleanups,
# and a doc drift check on "file removed" is noisy. Renames report the NEW
# destination path, so a rename off a sentinel path is intentionally exempt
# (if the file no longer lives under a sentinel directory, its drift story
# has already been decided elsewhere).
#
# `core.quotePath=false` prevents git from C-escaping non-ASCII paths,
# which would otherwise wrap the filename in literal double quotes and
# defeat the regex match.
staged=$(git -c core.quotePath=false diff --cached --name-only --diff-filter=ACMR || true)

if [[ -z "$staged" ]]; then
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
done <<<"$staged"

# No drift-prone source touched → nothing to check.
if [[ ${#touched_source[@]} -eq 0 ]]; then
  exit 0
fi

# Source touched AND docs also touched in the same commit → good enough.
if [[ ${#touched_doc[@]} -gt 0 ]]; then
  exit 0
fi

# Drift risk: source touched, no docs touched. Fail loudly with guidance.
{
  echo ""
  echo "════════════════════════════════════════════════════════════════════"
  echo "  📚  DOC DRIFT CHECK — staged commit touches drift-prone source"
  echo "      files but updates no user-facing documentation."
  echo "════════════════════════════════════════════════════════════════════"
  echo ""
  echo "Staged source files that commonly drift docs:"
  for f in "${touched_source[@]}"; do
    echo "  • $f"
  done
  echo ""
  echo "None of these user-facing docs are in the staged commit:"
  echo ""
  echo "  README.md              docs/*.md"
  echo "  CONTRIBUTING.md        packages/proxy/README.md"
  echo "  SECURITY.md            packages/dashboard/README.md"
  echo "  CODE_OF_CONDUCT.md     packages/python-sdk/README.md"
  echo "  DEPENDENCIES.md        docker/README.md"
  echo "                         examples/*/README.md"
  echo ""
  echo "If the change in any of the files above affects env vars, CLI"
  echo "flags, config keys, HTTP endpoints, curl / python / yaml snippets,"
  echo "file paths, function or method signatures, port numbers, perf"
  echo "claims, version strings, or anything a first-run user would"
  echo "copy-paste, update the relevant doc(s) in the same commit:"
  echo ""
  echo "  git add <doc-file>"
  echo "  git commit"
  echo ""
  echo "If this change is genuinely non-user-visible (internal refactor,"
  echo "test-only, comment-only, no behavior change), bypass this check:"
  echo ""
  echo "  git commit --no-verify"
  echo ""
  echo "Background and workflow:"
  echo "  .claude/helio_project/memory/feedback_sync_docs_with_code.md"
  echo ""
} >&2

exit 1
