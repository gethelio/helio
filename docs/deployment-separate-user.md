# Running Helio as its own user

This is tier 2 of
[SECURITY.md](../SECURITY.md#process-and-filesystem-boundaries): the proxy
runs as a dedicated system user on the host your agent works on, with its
config, the digest of its dashboard secret, and its audit database in
directories the agent's account cannot read or write. The recipe was run
end to end on 2026-09-03 on Ubuntu 24.04.4 LTS (arm64) with Helio 0.13.1,
and every expected line below is from that run.

**Who it's for:** you run a coding agent as a normal user account on a Linux
host, without Docker, and you want the four questions SECURITY.md asks (can
the agent write the config, read the secret, restart the proxy or set its
environment, write the audit database) answered no. If your agent runs in a
container, use the [sidecar recipe](./deployment-sidecar.md) instead.

## What you need

- Ubuntu 24.04 with `sudo`.
- A system-wide Node.js 24 whose `node` is on `sudo`'s `secure_path`
  (`/usr/local/bin` or `/usr/bin`). This page does not install it. An nvm
  install does not work here: `sudo` resets `PATH` to `secure_path`, and the
  nvm tree sits under a home directory that Ubuntu creates `0750`, unreadable
  by the proxy user.
- Helio installed system-wide, and the absolute path of the CLI:

```bash
sudo npm install -g @gethelio/proxy
readlink -f "$(command -v helio)"
```

For a `/usr/local` install the link is `/usr/local/bin/helio` and `readlink`
prints `/usr/local/lib/node_modules/@gethelio/proxy/dist/cli.js`. Every
command below that runs Helio as the proxy user uses `/usr/local/bin/helio`;
replace it if yours differs.

- An MCP server for `upstream.url`. The run used the demo echo server from
  the [Getting Started guide](./getting-started.md#no-mcp-server-to-test-with)
  on `127.0.0.1:8080`.

## 1. Create the proxy user

```bash
sudo useradd --system --user-group --home-dir /var/lib/helio --create-home --shell /usr/sbin/nologin helio
id helio
```

A system account with its own group, no login shell, and `/var/lib/helio` as
its home. `id` prints a uid below 1000 (`uid=999(helio) gid=999(helio)
groups=999(helio)` in the run).

## 2. Create its directories

```bash
sudo install -d -o root -g helio -m 0750 /etc/helio
sudo chmod 0700 /var/lib/helio
ls -ld /etc/helio /var/lib/helio
```

Expected:

```
drwxr-x--- 2 root  helio 4096 ... /etc/helio
drwx------ 2 helio helio 4096 ... /var/lib/helio
```

`/etc/helio` holds the config: root owns it, the `helio` group can enter it,
nobody else can. `/var/lib/helio` holds the audit database and the log, and
only the proxy user can enter it.

## 3. Write the config as root

```bash
sudo helio init -o /etc/helio/helio.yaml
sudo chown root:helio /etc/helio/helio.yaml
sudo chmod 0640 /etc/helio/helio.yaml
sudo stat -c '%U:%G %a inode=%i %n' /etc/helio/helio.yaml
```

`init` prints the dashboard secret once and writes only its SHA-256 digest
into the file. Keep the secret in your password manager; nothing on this host
needs to hold it. The `stat` line reads `root:helio 640 inode=<n>
/etc/helio/helio.yaml`; note the inode, step 6 checks it again.

Now make the file yours. Open it with `sudoedit /etc/helio/helio.yaml` (not
with an editor run as root; step 6 says why) and replace the contents with
the config below, keeping the `sha256:` digest that `init` wrote in place of
the placeholder digest:

```yaml
version: '1'

upstream:
  url: 'http://127.0.0.1:8080/mcp' # your MCP server
  transport: streamable-http

listen:
  port: 3000
  host: 127.0.0.1

policies:
  default: allow
  rules:
    # Deny anything the tool marks as destructive.
    - name: block-destructive
      match:
        annotations:
          destructiveHint: true
      action: deny

audit:
  storage: sqlite
  path: /var/lib/helio/helio-audit.db
  retention: 90d
  include_responses: true

dashboard:
  enabled: true
  port: 3100
  host: 127.0.0.1
  api_secret: 'sha256:0000000000000000000000000000000000000000000000000000000000000000'
```

`audit.path` is set in the file, so the database lands in the proxy user's
own directory rather than next to whatever directory the proxy happens to
start in. Both hosts stay on `127.0.0.1`: the agent edge on `:3000` and the
dashboard, the operator control plane, on `:3100`.

## 4. Validate and start as the proxy user

```bash
sudo -u helio -H /usr/local/bin/helio validate -c /etc/helio/helio.yaml
```

Expected: `Config is valid: /etc/helio/helio.yaml (1 policy rule, 0
budgets)`. Because it runs as `helio`, it also proves the proxy user can read
the file. `sudo -u helio` runs with `secure_path`, not with your `PATH`,
which is why the absolute path is there.

Start the proxy in the foreground:

```bash
sudo -u helio -H /usr/local/bin/helio start -c /etc/helio/helio.yaml
```

or in the background with the log in the proxy's own directory, which is
what the run did:

```bash
sudo -u helio -H bash -c 'nohup /usr/local/bin/helio start -c /etc/helio/helio.yaml >/var/lib/helio/helio.log 2>&1 &'
sudo grep -E 'listening|Policies|Watching' /var/lib/helio/helio.log
```

Expected:

```
Helio proxy listening on http://127.0.0.1:3000
Policies: 1 rule loaded (default: allow)
Dashboard API listening on http://127.0.0.1:3100
Watching /etc/helio/helio.yaml for policy changes
```

Confirm who runs it and who owns what it wrote:

```bash
ps -o user= -p "$(pgrep -u helio -f 'helio start')"
sudo ls -l /var/lib/helio
```

The process runs as `helio`, and the audit database is `helio:helio` with
mode `0600`.

This page stops at a proxy started by hand. It ships no systemd unit: the
environment the recipe was run in cannot witness one, and a recipe that has
not been run is not documentation.

## 5. Prove it from the agent's account

Log in as the account your agent runs as (`dev` in the run: a normal user
created with `useradd -m -s /bin/bash dev`, not in the `sudo` group) and ask
the four questions:

```bash
cat /etc/helio/helio.yaml; echo "exit: $?"
echo '# x' >> /etc/helio/helio.yaml; echo "exit: $?"
ls /etc/helio; echo "exit: $?"
kill -TERM "$(pgrep -u helio -f 'helio start')"; echo "exit: $?"
kill -HUP "$(pgrep -u helio -f 'helio start')"; echo "exit: $?"
cat "/proc/$(pgrep -u helio -f 'helio start')/environ"; echo "exit: $?"
ls /var/lib/helio; echo "exit: $?"
echo x >> /var/lib/helio/helio-audit.db; echo "exit: $?"
```

Every line must be refused with a non-zero exit: `Permission denied` for the
reads and writes (the config, the directory listings, the process
environment, the audit database), `Operation not permitted` for the two
signals. Then send a governed call; the agent keeps the network hop to the
agent edge, and that is the design:

```bash
curl -s -X POST http://127.0.0.1:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"delete_record","arguments":{"id":"rec_42"}}}'
```

Expected: a `-32001` error whose message starts `Policy denied: Matched
"block-destructive"`. The call was governed, denied by the rule, and
recorded in an audit database the agent cannot touch.

## 6. Change policy safely

```bash
sudoedit /etc/helio/helio.yaml
```

`sudoedit` copies the file to a temporary location, opens the copy with your
editor as you, and writes the result back into the original file. The owner,
group, mode, and inode do not change, and the running proxy reloads. The run
had no terminal, so it set `SUDO_EDITOR` to a `sed` expression that flips
the rule from `deny` to `allow`:

```bash
SUDO_EDITOR='sed -i s/action:\ deny/action:\ allow/' sudoedit /etc/helio/helio.yaml
sudo stat -c '%U:%G %a inode=%i %n' /etc/helio/helio.yaml
sudo tail -n 2 /var/lib/helio/helio.log
```

Expected: `root:helio 640` with the same inode as in step 3, and the log
ends with `[helio] Policy reloaded: 1 rule (default: allow)`. The same call
from the agent's account now returns `Record rec_42 deleted`.

Never replace the file. Copying it somewhere, editing the copy, and moving
the copy over the original is the natural thing to do and it breaks the
proxy:

```bash
sudo cp /etc/helio/helio.yaml /tmp/helio.yaml
sudo sed -i 's/action: allow/action: deny/' /tmp/helio.yaml
sudo mv /tmp/helio.yaml /etc/helio/helio.yaml
sudo stat -c '%U:%G %a inode=%i %n' /etc/helio/helio.yaml
sudo -u helio -H /usr/local/bin/helio validate -c /etc/helio/helio.yaml
```

The `stat` line now reads `root:root 640` with a new inode, and `validate`
as the proxy user reports `Invalid config: Cannot read config file:
/etc/helio/helio.yaml`. The running proxy does one of two things, and which
one is a matter of timing: it logs nothing, keeps serving the last policy it
read, and observes no later edit until it is restarted; or its file watcher
fails with `EACCES: permission denied, watch '/etc/helio/helio.yaml'`, which
Helio logs as an unhandled promise rejection and exits on, so the next call
is refused. Either way the repair is the same: fix the ownership and restart
the proxy.

```bash
sudo chown root:helio /etc/helio/helio.yaml
sudo chmod 0640 /etc/helio/helio.yaml
sudo pkill -TERM -u helio -f 'helio start'
sleep 1
sudo -u helio -H bash -c 'nohup /usr/local/bin/helio start -c /etc/helio/helio.yaml >>/var/lib/helio/helio.log 2>&1 &'
sudo grep -E 'listening|Policies|Watching' /var/lib/helio/helio.log
```

The grep prints the four startup lines a second time, the file the second
boot read is the repaired one, and the agent's call is denied again.
GNU `sed -i` run as root happens to keep the owner because it restores it
after writing; do not rely on that. `sudoedit` is the whole edit procedure.

## 7. Delete the workspace copy

If you ran `helio init` in your project before moving the live file under
`/etc/helio`, that copy is readable and writable by the agent's account, and
it holds the digest of a dashboard secret (versions through 0.13.0 held the
secret itself). Delete it from the agent's account:

```bash
rm -v ~/project/helio.yaml
```

Then confirm the dashboard from yours:

```bash
curl -s http://127.0.0.1:3100/api/health
```

Expected: `{"status":"ok","version":"0.13.1",...}`.

## macOS

This page was not run on macOS. Use the
[sidecar recipe](./deployment-sidecar.md), or create a second local user
account for the proxy and repeat the steps above with the paths and the
account tools macOS has; this page does not walk through that, because it
was not run.

## What this closes and what it does not

From the agent's account: the config cannot be written or read; the file
holds a digest, and the secret is in your password manager and nowhere on
the host; the proxy cannot be signaled and its environment cannot be read;
the audit database cannot be written. That is every answer SECURITY.md asks
for turned to no. What remains:

- The agent can re-point its own MCP client at any upstream it can reach
  without Helio. The answer is credential termination: put the upstream's
  credential in `upstream.headers` with `${VAR}` interpolation and set the
  variable only in the proxy's environment, which the agent cannot read here.
  It holds while the sole copy of the credential is there.
- The dashboard on `127.0.0.1:3100` is reachable from every account on the
  host, the agent's included. Its control-plane routes stay behind the
  secret, which the agent does not hold; `/api/health`, the login route, and
  the logout route answer without it.
- When the SDK sideband is enabled, the SDK token lives in the agent's
  process by design.

[SECURITY.md](../SECURITY.md#process-and-filesystem-boundaries) lists these
residuals in full.

## Related

- [Running Helio as a Sidecar](./deployment-sidecar.md): the container
  layout, with the config unmounted and Helio off the agent's network
- [Getting Started](./getting-started.md#production-checklist): the
  production checklist
- [Configuration Reference](./configuration.md): every `helio.yaml` field
