# Connectors, MCP and chat apps

Agents can already use any website through their browser. Connectors give them **apps' own tools** instead: faster, more reliable, and without screen-scraping. TeamBot speaks [MCP](https://modelcontextprotocol.io) (Model Context Protocol), so any MCP server works. Everything here lives under **Connect apps** (with team sign-in on, only owners can change it).

## App connectors (remote MCP servers)

### From the marketplace

**Connect apps → Marketplace** lists about 35 vendors' own MCP servers: Notion, GitHub, Linear, Atlassian, Zapier, Stripe, Supabase, Context7 and more. Each one was checked to accept TeamBot's sign-in.

1. Open the app's page and click to sign in. A browser window opens at the vendor, where you approve access with OAuth. TeamBot registers itself, stores the tokens encrypted, and refreshes them by itself.
2. Some servers (GitHub's, for example) don't register OAuth clients. For those, **paste a token** such as a personal access token. It is sent in a request header and stored as its own encrypted secret, so it is also scrubbed from tool output.
3. Under **Agents**, switch on the agents that may use the app. The page also lists every tool the app offers.

### Any other server, by address

Add a remote MCP server by its URL. It must use `https://` (`http://` is accepted only for `localhost`). Addresses ending in `/sse` use the older SSE transport, and anything else uses Streamable HTTP. Sign-in works the same way: OAuth if the server supports it, or a pasted token.

### Sign-in when TeamBot isn't on this machine

OAuth sends your browser back to `<TeamBot address>/api/connectors/callback`. If people open TeamBot at an address other than `http://127.0.0.1:8787`, set `TEAMBOT_PUBLIC_URL` to that address (for example `https://teambot.example.com`) so the sign-in returns to the right place.

### Some apps aren't in the catalog

Asana, HubSpot, Box and MongoDB are missing because their sign-in can't register TeamBot. Vercel and Figma are missing because they approve clients one by one. You can still add these by URL if you have a token they accept.

## Local MCP servers (`mcp.json`)

Servers that run as a local program, or that you'd rather configure in a file, go in `mcp.json` at the repository root (or wherever `TEAMBOT_MCP_CONFIG` points). It uses the same format as Claude's `.mcp.json`:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/srv/reports"]
    },
    "internal-api": {
      "url": "https://mcp.internal.example.com/mcp",
      "headers": { "Authorization": "Bearer {{secret:INTERNAL_MCP_TOKEN}}" }
    }
  }
}
```

- `command`/`args`/`env` start a program that talks MCP over stdio. `url`/`headers` connect to a remote server.
- Values can use `{{secret:NAME}}` for secrets stored in **Settings → Secrets**, so tokens stay out of the file.
- `mcp.json` is git-ignored. Don't commit it.
- **Local servers run on the TeamBot host, not inside an agent's computer.** A filesystem or shell server there acts on your machine with the server's permissions. Only add servers you'd trust with that, and point them at narrow folders.

## How agents use app tools

- Each tool reaches an agent as `mcp__<server>__<tool>`, for example `mcp__linear__create_issue`. Only agents switched on for that server get its tools.
- App tools are **external** actions, so by default **every call asks you first**. To let an agent read without approvals, add an `allow` rule for the read tools (see [Action policy](action-policy.md#let-one-agent-use-an-app-freely-and-ask-for-everyone-else)).
- What an app returns reaches the model as **untrusted content**.
- Read-only runs (monitoring routines) don't get app tools.

## Telegram and Slack

Talk to your agents from your phone, get their messages to you, and approve or deny with a button. Both bridges connect out from TeamBot (Telegram long polling, Slack Socket Mode), so **TeamBot doesn't need a public address**. Each accepts exactly one person: the one who pairs with a short-lived code. Messages from that person act as the workspace owner.

### Telegram

1. In Telegram, message **@BotFather**, send `/newbot` and pick a name.
2. Paste the bot token under **Connect apps → Telegram**.
3. Click to pair, then send `/start <code>` to your bot (or follow the link shown).

### Slack

1. Under **Connect apps → Slack**, copy the app manifest. In Slack, create an app **From a manifest**, pick your workspace and paste it.
2. Install the app, then paste two tokens: the **Bot User OAuth Token** (`xoxb-…`) and an **App-Level Token** with `connections:write` (`xapp-…`, under Basic Information → App-Level Tokens).
3. Pair your Slack user: DM the app `pair <code>` with the code shown.

### Using them

- **What comes to you:** approval requests (with Approve and Deny buttons), agents' DMs to you, and messages that @mention you.
- **Replying:** reply to a forwarded message (Telegram) or in its thread (Slack) to answer in that conversation. Start a message with `@Name` to DM that agent. Anything else goes to the last conversation you used.
- **Files:** photos and files you send land in `/shared/uploads/telegram/<date>/` or `/shared/uploads/slack/<date>/`, and agents can open them.
- **Slack channels as triggers:** with Slack connected, a [routine](routines-and-triggers.md#on-a-slack-message) can start on every message in a channel the app is in.

Bot tokens are reserved secrets. Agents can neither see them nor use them in `{{secret:…}}`.

## Coding agents

For substantial programming work, an agent can hand a task to **Claude Code**, **Codex** or **Gemini CLI** running inside its own computer with `run_coding_agent`. It's offered once the matching key is stored in **Settings → Secrets**: `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN`) for Claude Code, `OPENAI_API_KEY` for Codex, and `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) for Gemini CLI. The key goes only to the CLI's environment. Tasks handed to a coding agent go to the reviewer model by default. Coding-agent usage is billed by that provider, not counted in TeamBot's budgets.
