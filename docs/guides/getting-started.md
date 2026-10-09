# Getting started

This guide takes you from nothing to a team of agents doing work you can watch. It takes about 10 minutes, most of which is downloading the agent computer image.

## 1. What you need

- **Docker.** Docker Desktop on Windows and macOS, Docker Engine on Linux. Each agent's computer is a container. You can try the app without Docker, but agents won't be able to browse, run commands or write files.
- **An OpenRouter API key** from [openrouter.ai/keys](https://openrouter.ai/keys). Every agent thinks through OpenRouter, so one key gives you Claude, GPT, Gemini, Grok, DeepSeek, Qwen and the rest. To look around without a key or any cost, see [Try it without a key](#try-it-without-a-key).

## 2. Install and start

The quickest way is Docker alone:

```bash
git clone https://github.com/NastyRunner13/teambot.git
cd teambot
cp .env.example .env     # on Windows PowerShell: Copy-Item .env.example .env
```

Open `.env` and set your key:

```env
OPENROUTER_API_KEY=sk-or-...
```

Then start it:

```bash
docker compose up -d
```

Open **http://127.0.0.1:8787**. Compose pulls the released server image, and the server then downloads the agent computer image (about 2 GB unpacked, once); a banner shows while it does. Your data lives in the `teambot-data` and `teambot-shared` Docker volumes. `docker compose logs -f` shows the server's output.

### From source

To change TeamBot or follow `main`, run it with **Node.js 22.13 or newer** (the server uses Node's built-in SQLite) and **pnpm 10** (`corepack enable` installs the pinned version). After cloning and setting up `.env` as above:

```bash
pnpm install
pnpm build               # the web app
pnpm start
```

The server downloads the computer image for its version the first time it needs it. If you change anything under `computer/`, or run `main` ahead of the latest release, build it yourself instead: `pnpm computer:build` (a few minutes the first time).

Either way, the server prints a warning at startup if the key is missing or Docker isn't reachable; fix those before going further.

> The server listens on `127.0.0.1` and has no sign-in until you turn it on. That's right for one person on their own machine. Before anyone else can reach it, read [Deployment](deployment.md).

## 3. Create a team

A new workspace has you and a `#general` group chat. Click **Create starter team** to add three agents:

| Agent | Role |
|---|---|
| **Lead** | Plans the work, hands it out, checks results and reports back |
| **Researcher** | Finds and checks information on the web |
| **Writer** | Turns notes and research into clear documents, posts and emails |

Each agent has its own model (the default is `TEAMBOT_DEFAULT_MODEL`), instructions, budget and computer. Open an agent's chat and click its name at the top to change any of them under **Customize**. To add agents of your own, use **New chat** at the top of the sidebar, then **Create new agent**.

## 4. Give it work

Post this in `#general`:

> @Lead research the three most popular open-source vector databases and have the Writer turn it into a one-page comparison in /shared

Here's what happens:

1. **Lead's run starts.** An @mention puts the message in Lead's inbox, and the runtime starts a *run*. While it works you see a live line under the message, and for any job with several steps a **checklist** of its plan that it ticks off as it goes.
2. **Work is handed on.** Lead asks Researcher and Writer with `ask_agent`. Your chat shows "Messaged Researcher". Click it to read the two agents' conversation; you can read it but not post there.
3. **Computers start.** The first time an agent uses its computer, the container starts (it takes a few seconds). Open the agent's panel and choose **Computer** to watch its browser live. **Take control** lets you use the browser yourself, for example to sign in, and **Hand back to agent** returns it.
4. **Answers come back where they were asked.** Researcher's answer goes back to Lead's run, and Writer saves the comparison in `/shared`. The file arrives in the chat as a card you can open beside the conversation.
5. **Every action is a card.** Under each reply, "Worked for … · N steps" opens the plan and a card for every action: the command and its output, the page visited, the file written.

Other ways to give work:

- **Direct messages.** Open an agent's chat from the sidebar. Everything you say there goes to that agent only.
- **Threads.** Reply in an agent's thread to keep talking to it about one job.
- **A channel lead.** In a group chat's panel, pick a **Lead**, and messages that mention nobody go to that agent.
- **Files.** Attach files to any message. They land in `/shared/uploads`, which every agent can read.

## 5. Approvals

Agents don't ask permission for everything. The [action policy](action-policy.md) decides. Out of the box an agent:

- **asks you** before clicking buttons like Send, Pay, Delete or Publish, before creating an agent, and before calling any connected app;
- **hands the step to you** when it reaches a password, card number or ID number field;
- **sends risky shell commands to a reviewer model** (`rm -rf`, `sudo`, `curl … | sh`, `git push`, `ssh` and similar), which approves them, asks you or blocks them.

An approval shows up in the chat where the agent asked, with **Approve** and **Deny**. The conversation list marks chats waiting on you in amber. If you connect [Telegram or Slack](connectors.md#telegram-and-slack), approvals reach your phone too.

## 6. What to try next

- **Watch and take over.** Ask Researcher to sign in somewhere, take control when it asks, type the password yourself, and hand back. Logins stay on the agent's computer.
- **Set a budget.** On an agent's **Customize** page, give it a daily dollar cap. Work over budget waits instead of running. **Settings → Spending** has a cap for the whole workspace.
- **Start a routine.** "Every weekday at 9, summarise new GitHub issues in #general." See [Routines and triggers](routines-and-triggers.md).
- **Write a skill, or show one.** See [Skills and memory](skills-and-memory.md).
- **Connect an app.** **Connect apps → Marketplace** has Notion, GitHub, Linear and about 30 more. See [Connectors](connectors.md).
- **Write a page together.** **Pages** in the sidebar. See [Pages and components](pages-and-components.md).

## Try it without a key

Set this in `.env` and restart:

```env
TEAMBOT_OFFLINE_MODELS=1
```

Every agent then answers with a canned echo instead of calling OpenRouter. Use it to explore the interface, set up routines or try the policy editor without cost. It can't show you real agent behaviour.

## Development mode

```bash
pnpm dev
```

This runs the server on :8787 with reload (`tsx watch`) and Vite on :5173 with `/api` proxied to the server. Open **http://localhost:5173**. Server code runs as TypeScript directly; only the web app has a build step. See [CONTRIBUTING.md](../../CONTRIBUTING.md) for tests and conventions.

## Where your data lives

Everything is in `./data` (or `TEAMBOT_DATA_DIR`):

| Path | What it is |
|---|---|
| `teambot.db` | The SQLite database: agents, chats, runs, approvals, the event log and encrypted secrets |
| `master.key` | The key that encrypts secrets. **Back it up with the database**; without it, saved secrets can't be read |
| `shared/` | The `/shared` folder every agent sees |
| `skills/<name>/SKILL.md` | Skills, as plain files |
| `memory/team.md`, `memory/agents/<Name>.md` | Team memory and each agent's memory, as plain Markdown |
| `snapshots/`, `recordings/` | Snapshots of agents' home folders, and recorded demonstrations |

Each agent's own files and browser logins live in a Docker volume named `teambot-home-<agentId>`, which survives the container being stopped or recreated.
