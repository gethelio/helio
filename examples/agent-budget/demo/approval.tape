# Recording 1: the agent calls a write tool; the approver reads the tool,
# the door, the rule and the arguments. Run through record.mjs, which boots
# the example, logs the dashboard in on the Approvals page, records that
# window and clicks Approve when this tape touches cues/approve. Both
# headers on the MCP lines, the bearer from process.env on the API line.

Require curl
Require jq
Require node

Output out/approval-terminal.mp4

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

# The tools door and its tool set
Type "curl -s -H 'Content-Type: application/json' -H 'x-helio-session-id: coding-agent-run' -d @calls/list.json http://127.0.0.1:3000/mcp/tools | jq -r '.result.tools[].name'"
Enter
Sleep 2s

# The arguments the agent is about to send
Type "jq -c '.params.arguments' calls/run-job.json"
Enter
Sleep 3s

# The write tool, held by the approve-job-runs rule; the next line prints
# the ticket id; the wait builtin blocks until the approval lands
Type "date -u +%H:%M:%S"
Enter
Sleep 500ms
Type "curl -s -H 'Content-Type: application/json' -H 'x-helio-session-id: coding-agent-run' -d @calls/run-job.json http://127.0.0.1:3000/mcp/tools &"
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
Sleep 3s
