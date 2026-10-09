# Troubleshooting

Start with two things: **the server's startup output** (it warns about a missing key, unreachable Docker and a missing computer image) and **`GET /api/health`**. Then find the symptom below.

To see exactly what an agent did, open its reply's "Worked for … · N steps" note and then the full log. Every model call, tool call, policy decision and approval is there, in order.

## Agents

### An agent doesn't start working

Check these in order:

1. **Was it actually addressed?** In a group chat, an agent only wakes when @mentioned, unless it is the chat's **Lead**. In a DM with an agent, only that agent gets messages. Mentioning a second agent there doesn't wake it; the agent you're talking to decides whether to bring the other one in.
2. **Is everything paused?** The profile menu (bottom left) has **Pause all agents**. If it says **Resume all agents**, everything is paused.
3. **Is the agent paused, or under your control?** Check its status in its panel. While you have taken control of its computer, it waits.
4. **Is it waiting for you?** Chats with a pending approval are marked in amber in the conversation list.
5. **Is it over budget?** Work over an agent's daily or monthly cap, or the workspace's daily cap, waits in the queue with a message saying so. Raise the cap on its Customize page or in **Settings → Spending**, or wait for the next day.
6. **Is it busy?** An agent runs one job at a time, and at most `TEAMBOT_MAX_CONCURRENT_RUNS` agents (default 4) run at once. Messages for a different conversation wait for their own run.

### "Out of credits", "model not found" or other model errors

- **402 / out of credits:** add credits at openrouter.ai.
- **Model not found or doesn't support tool calling:** agents need models that support tool calling on OpenRouter. Pick another model on the agent's Customize page.
- **No key:** set `OPENROUTER_API_KEY` in `.env` and **restart**. The server reads `.env` only at startup, and variables already set in your environment win over `.env`.

### The agent stopped and said it reached the step limit

A run makes at most `TEAMBOT_MAX_STEPS_PER_RUN` model calls (default 40). Reply **"continue"** in the same conversation, and the next run picks up with everything the last one did and found. Raise the limit if this is common for your work.

### The reply was garbled or empty

Some models occasionally return broken output. TeamBot never posts it: it asks the model once more, and after two broken replies in a row the run fails with a message to pick another model. If a model often ends with an empty reply, TeamBot asks it once for the answer and otherwise leaves a note in the chat. If this keeps happening, choose a different model for that agent.

### Agents stop handing work to each other

- **Loop guard:** after `TEAMBOT_MAX_AGENT_DEPTH` agent-to-agent hops without a person (default 6), further messages are dropped so agents can't ping-pong forever. A person's message resets it.
- **Handoff limit:** one run may hand work to at most `TEAMBOT_MAX_HANDOFFS_PER_RUN` teammates (default 4), counting `ask_agent` and @mentions of agents in group chats.
- `ask_agent` refuses agents that are paused, over budget, or past the hop limit, and tells the asking agent why.

### It keeps asking for approval

Open the approval card: it names the rule that asked. Then:

- Connector (`mcp__…`) tools, `create_agent` and `create_routine` are external actions, which ask by default.
- Clicks on buttons labelled Send, Submit, Pay, Delete, Confirm and similar ask by default.
- A `review` rule asks you whenever the reviewer model is unsure or fails. Check that `TEAMBOT_REVIEWER_MODEL` (or the utility model) is a model your key can use.
- If the policy shown in Settings has an error banner, TeamBot is in **safe mode** and asks for everything except team tools until you save a valid policy.

See [Action policy](action-policy.md) to change any of this.

### It forgot something

Memory files go into the prompt only up to 8,000 characters each. Open the agent's **Memory** and tidy it. Also check the note was saved with the right scope: an agent's own memory isn't shared with teammates, but team memory is.

## Computers

### Tool calls fail with Docker or computer errors

- **Docker isn't running.** On Windows and macOS, start Docker Desktop. Restarting the TeamBot server isn't needed. The next tool call tries again.
- **The image is missing.** The server downloads its published image when it's missing (**Settings → System** shows **Downloading…**); if that fails, check the server's log and its internet connection. If `TEAMBOT_COMPUTER_IMAGE` names another image, build it: `pnpm computer:build` makes TeamBot's under both its published name and `teambot/computer:latest`.
- **A custom image is broken.** If the agent has its own base image on its Customize page, check that it was built from TeamBot's image and that the name is right.
- **The setup script failed.** The Computer tab shows the setup script's status and output. Fix the script; it runs again once it changes.

### Changes under `computer/` don't show up

Rebuild the image with `pnpm computer:build`. Running computers keep the image they started with: **Stop** the computer in its Computer tab, and it is recreated from the new image on next use, keeping its home folder.

### The agent can't reach a site

If the agent has an internet **allowlist**, look under **Blocked sites** in its Computer tab. Sites often need more domains than their own: sign-in providers, CDNs, APIs. Add them to the allowlist. Without an allowlist, check whether the site blocks automated browsers. You can take control to get past a check yourself.

### A login disappeared

Logins live in the agent's home volume (`teambot-home-<agentId>`), which survives stops and image changes. They are lost if the computer was wiped with **Reset**, or an older snapshot was restored. Sites also expire sessions on their own.

### The live screen is blank or won't connect

The live view is a WebSocket at `/api/agents/<id>/vnc`. Behind a reverse proxy, make sure WebSockets are passed through (see [Deployment](deployment.md#put-it-behind-https)). A sleeping computer starts when the agent next needs it, or when you press **Start** in its Computer tab.

## Routines and integrations

### A routine didn't run on time

- Cron times use the **server's local time zone** (UTC in Docker unless `TZ` is set).
- A routine for a paused or over-budget agent waits.
- A time missed while the server was down is not made up later.
- Check that the routine's switch is on. Its page shows the next run.

### An email or calendar routine shows an error

The routine's page shows when it last checked and the last error. **Check now** tries again at once. For Gmail and Outlook, use an **app password**. For Google Calendar, use the **secret** iCal address, not the public one.

### A webhook call returns 404

The URL or the token is wrong (TeamBot answers 404 for both, so it reveals nothing). Copy both again from the routine's page. If you made a new token, the old one stopped working. `409` means the routine is turned off, and `429` means ten calls are already waiting.

### A connector stopped working

Open it under **Connect apps → Installed**. If it says it needs sign-in, sign in again. Tokens normally refresh by themselves, but a revoked grant or an expired pasted token needs you. Check that the agent is still switched on for it. Read-only runs never get connector tools.

### Connector sign-in returns to the wrong address

Set `TEAMBOT_PUBLIC_URL` to the address people open TeamBot at, and restart.

## Data and the web app

### "Secret could not be decrypted" after moving TeamBot

Secrets are encrypted with `data/master.key` (or `TEAMBOT_MASTER_KEY`). Move or restore the key together with the database. Without the original key, delete those secrets and enter them again.

### The web app shows a blank page

- After pulling changes, run `pnpm build`. `pnpm start` serves `apps/web/dist` as it was last built.
- In development, open `:5173` (Vite), not `:8787`.
- Check the browser console. Contributors: see the zustand and effect gotchas in [CLAUDE.md](../../CLAUDE.md#gotchas).

### The UI looks stale

Live updates come over the `/api/ws` WebSocket. Reload the page. If it keeps happening behind a proxy, check that the proxy passes WebSockets and doesn't time them out quickly.

## Windows notes

- Docker Desktop isn't always running after a reboot. Start it before giving agents work.
- The first TypeScript import after starting the server is slow (7–10 seconds), more so inside a OneDrive folder. That's normal.
- Use `Copy-Item .env.example .env` instead of `cp` in PowerShell, and `$env:NAME = 'value'` instead of `NAME=value command`.

## Still stuck?

Open an issue with the startup output, the `/api/health` response (it contains no secrets), what you expected and what happened. For security problems, please don't open a public issue. See [CONTRIBUTING.md](../../CONTRIBUTING.md#reporting-security-issues).
