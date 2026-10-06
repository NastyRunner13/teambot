# Deployment

Out of the box, TeamBot is a personal tool. It listens on `127.0.0.1`, has no sign-in, and whoever can open the page acts as the owner. This guide covers running it for a small team on a server: where to run it, turning on sign-in, putting it behind HTTPS, tightening isolation, and keeping it backed up and up to date.

Read the [Security model](../../README.md#security-model) first. The short version: **the TeamBot server controls Docker, which makes it privileged on its host.** Run it on a machine you control and that does nothing else important.

## Choose how to run it

| | From source (`pnpm start`) | Docker Compose |
|---|---|---|
| Needs | Node 22.13+, pnpm 10, Docker | Docker only |
| Data | `./data` | Volumes `teambot-data` and `teambot-shared` |
| Agent computers reach the server via | `host.docker.internal` | The `teambot` Docker network |
| Good for | Your own machine, development | A server |

### Docker Compose

```bash
docker build -t teambot/computer:latest ./computer   # the agent computer image
cp .env.example .env                                  # set OPENROUTER_API_KEY and the rest
docker compose up -d --build                          # → http://127.0.0.1:8787
```

Compose publishes the port on `127.0.0.1` only (`TEAMBOT_PORT` changes the host port). The server container mounts the Docker socket to start one computer per agent on the private `teambot` network. Computers can't reach the server's API: their firewall blocks it, and the server refuses requests from computer addresses as a second lock.

### From source

```bash
pnpm install && pnpm computer:build && pnpm build
pnpm start
```

To keep it running, use whatever supervises services on your host (systemd, pm2, a Windows service). The server shuts down cleanly on `SIGINT`/`SIGTERM`, and runs in progress are re-queued when it starts again.

## Turn on team sign-in

Do this **before** anyone else can reach the server.

1. Open **Settings → Team** and choose **Turn on team sign-in**. Set your password (at least 10 characters). You become the first owner.
2. Choose **Invite** to make a one-time invite link for each teammate, who joins as a member. Links expire, can be revoked, and work once.
3. Each person chooses a password when they open the link, then signs in with their name and password. Sessions are HttpOnly cookies. **Remove** signs a member out for good. Their messages stay.

What team mode changes:

- **Owners** manage the action policy, secrets, connectors, Telegram and Slack, components, the workspace spending cap and the team. They also set agents' setup scripts, base images, internet access and budgets.
- **Members** do everything else: chat with any agent, create agents, start routines, write pages.
- **Group chats and every agent are shared.** Agents' work logs are visible to the whole team. Only direct messages that include a person are private to their members. When an agent works in a conversation, it can only read what everyone in that conversation could read.
- Bridges (Telegram, Slack), routines without a channel and webhooks still act as the owner.

After eight failed sign-ins for a name or from an address, sign-in pauses for 15 minutes. Behind a reverse proxy every request comes from the proxy's address, so failed attempts by anyone count against everyone. If that's a concern, limit who can reach the sign-in page at the proxy.

## Put it behind HTTPS

TeamBot speaks plain HTTP and expects a reverse proxy in front of it for TLS. Keep the server on `127.0.0.1` (or the Compose port on `127.0.0.1`) and let the proxy be the only way in.

Set the public address in `.env` and restart:

```env
TEAMBOT_PUBLIC_URL=https://teambot.example.com
```

It is used for three things: connector sign-ins return to it, session cookies get the `Secure` flag, and the API accepts changes from pages on that origin.

The proxy must pass **WebSockets** through. Live updates use `/api/ws`, and the agent's screen uses `/api/agents/<id>/vnc`. It must also keep the `Host` header.

**Caddy** (gets and renews certificates by itself, and proxies WebSockets out of the box):

```caddy
teambot.example.com {
  reverse_proxy 127.0.0.1:8787
}
```

**nginx:**

```nginx
server {
  listen 443 ssl;
  server_name teambot.example.com;
  # ssl_certificate / ssl_certificate_key …

  client_max_body_size 50m;   # file uploads

  location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 1h;    # keep live views and the event stream open
  }
}
```

**Webhooks from outside.** `/api/hooks/<id>` is the only API path open without sign-in. It is protected by each routine's token. If outside services must reach webhooks but people only reach TeamBot over a VPN, expose just `/api/hooks/` publicly.

Don't set `HOST=0.0.0.0` to skip the proxy. The server warns at startup if it listens beyond this machine without sign-in, and even with sign-in, traffic would be unencrypted.

## Tighten isolation

- **gVisor.** On Linux, install [gVisor](https://gvisor.dev) as a Docker runtime and set `TEAMBOT_SANDBOX_RUNTIME=runsc`. Agent computers then run under a user-space kernel, a much stronger boundary than a plain container. (Chromium inside runs with `--no-sandbox`, so the container boundary is what isolates it.)
- **Internet allowlists.** On an agent's Customize page, switch internet access from open to an allowlist of domains. Its computer is then firewalled so its only way out is its own egress proxy, which lets through the listed domains and refuses the rest. Blocked requests show under **Blocked sites** in the agent's Computer tab. Each restricted agent uses one port from `TEAMBOT_EGRESS_PORTS` (default `18800-18999`).
- **Resource limits.** `TEAMBOT_COMPUTER_MEMORY_MB` (default 2048) and `TEAMBOT_COMPUTER_CPUS` (default 2) apply per agent. `TEAMBOT_MAX_CONCURRENT_RUNS` (default 4) caps how many agents work at once.
- **Budgets.** Set a workspace daily cap in **Settings → Spending**, and per-agent caps on each agent's Customize page. Work over budget waits instead of running.
- **Local MCP servers** in `mcp.json` run on the host, not in a computer. Keep that file to servers you'd trust with the host.

## Back up

| What | Where (source) | Where (Compose) |
|---|---|---|
| Database: agents, chats, runs, policy, encrypted secrets, event log | `data/teambot.db` (+ `-wal`, `-shm`) | volume `teambot-data` |
| **Master key** for secrets | `data/master.key`, or `TEAMBOT_MASTER_KEY` | volume `teambot-data` |
| Skills, memory, recordings, snapshots | `data/skills`, `data/memory`, `data/recordings`, `data/snapshots` | volume `teambot-data` |
| `/shared` | `data/shared` | volume `teambot-shared` |
| Each agent's home folder (files, browser logins) | Docker volume `teambot-home-<agentId>` | same |

- **Keep the master key with the database.** Secrets can't be decrypted without the key they were encrypted with. Store the key somewhere safer than the backup itself, or set `TEAMBOT_MASTER_KEY` (32 bytes, base64) from a secret manager.
- **Stop the server before copying the database.** It uses SQLite in WAL mode, and copying a live database can give you an inconsistent copy. A short stop is enough. Runs resume when it starts again.
- For an agent's home folder, **snapshots** in its Computer tab save it as an archive under `data/snapshots/`, so a data backup includes them. You can also back up the Docker volumes directly.

## Upgrade

1. **Back up** (see above).
2. Get the new version: `git pull`, or download a [release](https://github.com/NastyRunner13/teambot/releases). A release archive includes the built web app.
3. Rebuild:

   ```bash
   pnpm install
   pnpm build
   pnpm computer:build      # only if computer/ changed, but harmless otherwise
   ```

   With Compose: `docker build -t teambot/computer:latest ./computer && docker compose up -d --build`.
4. Restart the server. Database migrations run automatically at startup and only ever add to the schema.

**Agent computers keep the image they were started with** until they stop. A stopped computer is recreated from the new image on its next use, and its home volume is kept. Computers stop by themselves after `TEAMBOT_COMPUTER_IDLE_MINUTES` (default 30) without use. You can also **Stop** one from its Computer tab.

Your saved action policy is never changed by an upgrade. To adopt new default rules, see [Action policy](action-policy.md#changing-the-default).

## Observe it

- **`GET /api/health`** reports whether the OpenRouter key is set, Docker is reachable, the computer image exists, and the state of connectors and telemetry.
- **OpenTelemetry:** set `OTEL_EXPORTER_OTLP_ENDPOINT` (OTLP over HTTP) to send the audit log as logs and every run as a trace with model and tool spans. `OTEL_EXPORTER_OTLP_HEADERS` and `OTEL_SERVICE_NAME` work as usual.
- **The audit log** is in the database's `events` table and at `GET /api/events`: every message, model call (with tokens and cost), tool call, policy decision, review and approval.
