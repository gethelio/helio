# Recording 2: one $50 budget, three merchants, three servers, same agent
# mandate. Run through record.mjs, which boots the example, logs the
# dashboard in, records the dashboard window and answers the cue files this
# tape touches under cues/. Every MCP line carries both headers: the door
# answers 415 without the Content-Type, and a call without the session id
# charges nothing. The two API lines read the bearer from process.env,
# which VHS passes to the tape's zsh; nothing typed carries the secret.

Require curl
Require jq
Require node

Output out/budget-terminal.mp4

Set Shell zsh
Set FontSize 15
Set Width 1000
Set Height 800
Set Padding 16
Set Framerate 30
Set TypingSpeed 10ms

Type "date -u +%H:%M:%S"
Enter
Sleep 1s

# Three doors, three tool sets
Type "curl -s -H 'Content-Type: application/json' -H 'x-helio-session-id: coding-agent-run' -d @calls/list.json http://127.0.0.1:3000/mcp/compute | jq -r '.result.tools[].name'"
Enter
Sleep 2s
Type "curl -s -H 'Content-Type: application/json' -H 'x-helio-session-id: coding-agent-run' -d @calls/list.json http://127.0.0.1:3000/mcp/market-data | jq -r '.result.tools[].name'"
Enter
Sleep 2s
Type "curl -s -H 'Content-Type: application/json' -H 'x-helio-session-id: coding-agent-run' -d @calls/list.json http://127.0.0.1:3000/mcp/tools | jq -r '.result.tools[].name'"
Enter
Sleep 2s

# Four allowed calls: 20, 8, 8, 8
Type "curl -s -H 'Content-Type: application/json' -H 'x-helio-session-id: coding-agent-run' -d @calls/top-up-compute.json http://127.0.0.1:3000/mcp/compute"
Enter
Sleep 2s
Type "curl -s -H 'Content-Type: application/json' -H 'x-helio-session-id: coding-agent-run' -d @calls/get-prices.json http://127.0.0.1:3000/mcp/market-data"
Enter
Sleep 2s
Type "curl -s -H 'Content-Type: application/json' -H 'x-helio-session-id: coding-agent-run' -d @calls/get-prices.json http://127.0.0.1:3000/mcp/market-data"
Enter
Sleep 2s
Type "curl -s -H 'Content-Type: application/json' -H 'x-helio-session-id: coding-agent-run' -d @calls/get-prices.json http://127.0.0.1:3000/mcp/market-data"
Enter
Sleep 2s

# The call that crosses the line, held in the background; the next line
# prints its ticket id; the wait builtin blocks until the approval lands
Type "date -u +%H:%M:%S"
Enter
Sleep 500ms
Type "curl -s -H 'Content-Type: application/json' -H 'x-helio-session-id: coding-agent-run' -d @calls/run-check.json http://127.0.0.1:3000/mcp/tools &"
Enter
Sleep 1.5s
Type `node -e 'const r=await fetch("http://127.0.0.1:3100/api/approvals?status=pending",{headers:{authorization:"Bearer "+process.env.HELIO_DASHBOARD_SECRET}});console.log((await r.json()).data[0].id)'`
Enter
Sleep 1s
Type "touch cues/approve"
Enter
Sleep 500ms
Type "wait"
Enter
Wait@60s
Sleep 1.5s

# The ledger row with its badge
Type "touch cues/expand-1"
Enter
Sleep 5s

# Restart from the same directory; the ledger kept it. The waiter exits 0
# on cues/restart-ready, so the events line reads the second process.
Type "date -u +%H:%M:%S"
Enter
Sleep 500ms
Type "touch cues/restart"
Enter
Sleep 500ms
Type `node wait-ready.mjs && node -e 'const r=await fetch("http://127.0.0.1:3100/api/budgets/coding-agent-run/events",{headers:{authorization:"Bearer "+process.env.HELIO_DASHBOARD_SECRET}});const e=(await r.json()).data[0];console.log(e.kind,e.tool_name,e.upstream)'`
Enter
Wait@45s
Sleep 1s
Type "touch cues/expand-2"
Enter
Sleep 6s
