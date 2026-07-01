#!/usr/bin/env bash
#
# Smoke test for the Docker Compose demo stack (docker/).
#
# Assumes the stack is already running (docker compose up) and the proxy's
# MCP edge is reachable at $HELIO_MCP_URL (default http://localhost:3000/mcp).
# Asserts the governance contract end to end against the bundled echo server:
#
#   - tools/list returns the demo tools
#   - get_weather (read-only)   is ALLOWED
#   - delete_record (destructive) is DENIED by the block-destructive rule
#
# Exits non-zero on the first failed assertion. Used by the docker job in
# .github/workflows/ci.yml, and runnable locally against a running stack.

set -euo pipefail

MCP_URL="${HELIO_MCP_URL:-http://localhost:3000/mcp}"

fail() {
  echo "SMOKE FAIL: $1" >&2
  exit 1
}

post() {
  curl -sS --max-time 10 -X POST "$MCP_URL" \
    -H 'Content-Type: application/json' \
    -d "$1"
}

echo "Smoke testing $MCP_URL"

# 1. tools/list returns the demo tools.
list=$(post '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
for tool in get_weather send_email delete_record; do
  if ! grep -q "\"$tool\"" <<<"$list"; then
    fail "tools/list is missing \"$tool\" (got: $list)"
  fi
done
echo "ok: tools/list returned the demo tools"

# 2. get_weather is read-only, so the allow-reads rule permits it.
weather=$(post '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_weather","arguments":{"city":"London"}}}')
if grep -q '"error"' <<<"$weather"; then
  fail "get_weather should have been allowed (got: $weather)"
fi
if ! grep -q 'Sunny' <<<"$weather"; then
  fail "get_weather did not return the expected result (got: $weather)"
fi
echo "ok: get_weather allowed"

# 3. delete_record is destructive, so the block-destructive rule denies it.
del=$(post '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"delete_record","arguments":{"id":"rec_42"}}}')
if ! grep -q '"error"' <<<"$del"; then
  fail "delete_record should have been blocked (got: $del)"
fi
if ! grep -q 'block-destructive' <<<"$del"; then
  fail "delete_record denial did not name the block-destructive rule (got: $del)"
fi
echo "ok: delete_record denied by block-destructive"

echo "SMOKE PASS: governance enforced (read allowed, destructive denied)"
