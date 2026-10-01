# Landscape: AI teammates that have their own computer

*Research as of 2026-10-01. These are the notes behind [FEATURE_MAP.md](../FEATURE_MAP.md).*

Most of these products launched in the last eight weeks: Grok Bot on Aug 11, Muse on Sep 8, Manus Cue on Sep 28 and OpenAI Dots on Sep 29. The details below come from launch posts, vendor docs and early coverage. Where sources disagree, the disagreement is noted rather than resolved.

## The category in one paragraph

An agent is no longer a chat session. It is a **persistent, named worker**. It has (1) its own always-on computer (a browser, terminal, filesystem and sometimes a full desktop), (2) a way to sign into the same apps a human uses, even apps without an API, (3) a chat-style relationship with its human, who acts as a manager rather than an operator, (4) the ability to message and hand work to *other* agents, (5) schedules and event triggers so it works while you're offline, and (6) a permission layer that decides what it may do on its own, what needs approval, and what it must hand back to a human.

## Timeline

| Date | Launch |
|---|---|
| 2025-11 | OpenClaw, first released as *Warelay*, then renamed Clawdbot → Moltbot → OpenClaw (Jan 2026) |
| 2026-02 | Hermes Agent (Nous Research). Claude Code *Agent Teams*. Perplexity *Computer* (Feb 25) |
| 2026-04-08 | Claude Managed Agents |
| 2026-07-21 | Block *Buzz* (Apache-2.0) |
| 2026-08-11 | xAI **Grok Bot** (beta) |
| 2026-08-30 | OpenClaw 2.0 |
| 2026-09-08 | Meta **Muse** |
| 2026-09-28 | Manus 2.0 + **Cue** |
| 2026-09-29 | OpenAI **Dots** + ChatGPT Space (DevDay) |

---

## 1. Grok Bot (xAI, built and hosted with Cursor)

**Pitch:** "Always-on AI teammates" that you message like coworkers. They sign into your existing tools and finish multi-step jobs unsupervised.

- **Computer.** Each *member* (not each bot) gets one persistent cloud Linux machine. xAI's security docs describe it as a dedicated Firecracker microVM with a durable disk, browser, filesystem and terminal. **All of a member's Bots share it**, so files, browser sessions and CLI credentials carry between them. Each Bot gets its own *screen* for parallel work, with one computer-use task per screen at a time. The docs say twice: *do not treat separate Bots as a security boundary.*
- **Multi-agent.** You can run several named Bots per account. They message each other, share context in threads, and work in **group chats** where they "pass work, assign ownership" and pull you in only for judgment calls. The launch post shows a chief-of-staff Bot managing specialists. Some reviewers say the docs don't formalise that hierarchy.
- **Bot setup.** Each Bot has a name, a primary job and a description. The docs push you toward focused Bots, saying a focused Bot builds more useful context than one catch-all helper. Teams can publish **Team Bots and templates** and auto-assign them to members' sidebars by group.
- **Skills and Routines.** A **Skill** is a reusable instruction set. You can create one by **recording yourself doing the task (capped at 10 minutes)**. A **Routine** binds a skill to a specific Bot plus a schedule or event trigger. Routines are reportedly capped at 50.
- **Delegation.** Bots can launch Cursor *Cloud Agents* and subagents on separate computers. Admins can turn this off.
- **Approvals.** **Auto Review** is a separate reviewer model. It checks shell commands, plugin calls, computer use, *automation writes* (changes to routines and triggers) and delegation before they run. Each action is allowed, sent for approval, or denied. The prompt gives *Allow once / Always allow / Deny*. Rule types are *Ask first* and *Allow automatically*, plus team rules. **"Ask first" wins on conflict.** It does not review memory writes.
- **Human handoff.** For passwords, passkeys, 2FA, CAPTCHAs and payments, the human takes the screen ("Open computer") and the Bot waits. A **secure secret request** masks the value and keeps it out of the transcript and away from the model.
- **Local machine.** The desktop app can let Bots run commands and move files on your own machine. It defaults to *ask every time*. Admins can cap this at always, ask or never.
- **Prompt-injection defence.** Outside content is marked as untrusted when shown to the model. This is layered with Auto Review, network policy and approvals.
- **Integrations.** Built-in connectors for Gmail, Google Calendar, Google Drive, OneDrive, Outlook Mail and Calendar, Teams, SharePoint and Salesforce. Custom MCP servers must be publicly reachable. Connector tokens stay on the backend, never on the computer.
- **Identity.** Bots act *as the signed-in member*. There is no separate machine identity.
- **Enterprise.** Network Controls with four modes (no policy, allow-all, defaults plus allowlist, allowlist only), covering domains and IP:port. Changes reach running computers in about 60s. Also Team Setup (setup manifests run on every computer), Team Secrets (100 per team, 32 KB each), Action Recording (scrubbed commands, 90-day retention, OpenTelemetry export), audit logs, SCIM, an Admin API, bulk recreate or terminate of computers, auto-terminate after 30 days idle, and "Enforce Auto-review".
- **Platforms and price.** Desktop (macOS, Windows; Linux reports conflict) and iOS 18+. Bundled into SuperGrok Heavy, Cursor Ultra ($200/mo) and Cursor Teams Premium. Reported standalone pricing conflicts ($200/mo after a 14-day trial vs. $120/mo). The underlying model is not named in the docs.
- **Criticism.** Shared VM with no per-bot isolation. Memory you can't inspect, export or delete. Model lock-in. Desktop and iOS only, with no Slack, email or phone. Bot deletion is soft, so credentials can persist on the shared machine.

Sources: [x.ai launch](https://x.ai/news/introducing-grok-bot) · [security docs](https://cursor.com/docs/grok-bot/security) · [get started](https://cursor.com/docs/grok-bot/get-started) · [teams/enterprise](https://cursor.com/docs/grok-bot/teams) · [Digital Applied](https://www.digitalapplied.com/blog/grok-bot-ai-teammates-launch-cloud-computer-2026) · [Vellum breakdown](https://www.vellum.ai/blog/official-grok-bot-breakdown) · [note.com comparison](https://note.com/ai_driven/n/n2d0ace3afee5?hl=en)

## 2. OpenAI Dots + ChatGPT Space

**Pitch:** Persistent agents on GPT-6 Astra that keep working after you close the chat. They monitor projects, use software, react to new information and bring finished work back for approval.

- **Computer.** Each dot has **its own cloud computer and browser**. You can inspect its work at any time. Your laptop stays isolated unless you explicitly connect it. Reported model performance: 72.6% on OSWorld 2.0, with roughly 40-minute tasks.
- **Always-on and proactive.** A dot takes a goal and keeps working between conversations. When idle it runs **proactive research using read-only tools only**, so it can't send messages, modify content or control the browser in the background.
- **Custom Rules.** There are four behaviours per action type: (1) *act without asking*, (2) *act only if you explicitly asked for it*, (3) *ask first*, (4) *hand off to you* (the dot prepares and you execute). Passwords, data deletion and software installs always need approval.
- **Auto-review.** It checks consequential actions (anything affecting accounts or sharing information) against your instructions, Custom Rules and OpenAI safety requirements. **It cannot be turned off.** Safety monitoring can also pause or stop a dot.
- **Activity View.** You can watch background work and redirect it.
- **Credentials.** A dot logs into supported sites with saved credentials *without the password being exposed to the model*.
- **Surfaces.** ChatGPT web, desktop and mobile, plus **Slack and Microsoft Teams**. Texting and phone (audio) are "coming soon".
- **Integrations.** Around 4,000 apps through ChatGPT apps/plugins. A dot can kick off work in **Codex** (code: bug → fix → PR with demo video) and ChatGPT Work.
- **Memory.** It inherits ChatGPT memory and learns your preferences, standards and habits. Proactive research and private notes are not used for training.
- **ChatGPT Space.** A shared workspace for humans, ChatGPT, Codex and dots. It replaces Library. **Pages** are co-edited in real time. You can comment and **@mention a dot** to request work. Pages stay synced with Slack, email and calendar, and you choose which sources to check and how often. Sharing a Page never exposes private chats or memory.
- **Specialist Dots** (enterprise pilot). These have their **own organisational identity and credentials** and a fixed business role: procurement, invoices, email marketing, support or contracting. They are integrated with Microsoft Agent 365.
- **Availability.** One dot per account at launch, with more planned. Included in Pro and Business Premium. Enterprise, Edu and Healthcare get a beta that admins enable. Setup is desktop-only, 18+, and Pro excludes the EEA, UK and Switzerland at launch. There is no self-hosting.

Sources: [VentureBeat](https://venturebeat.com/technology/openai-launches-dots-always-on-ai-agent-coworkers-and-chatgpt-space-where-they-can-collaborate-with-human-teams) · [MarkTechPost](https://www.marktechpost.com/2026/09/29/openai-launches-dots-always-on-gpt-6-astra-agents-that-work-from-their-own-cloud-computers/) · [TNW](https://thenextweb.com/news/openai-dots-always-on-ai-agents-cloud-computers-devday) · [Codersera guide](https://codersera.com/blog/openai-chatgpt-dots-guide-2026/) · [TechCrunch](https://techcrunch.com/2026/09/29/openai-launches-dots-its-bubbly-agentic-avatar/)

## 3. "OpenBot": two different projects share the name

### 3a. nightly-labs/openbot (openbot.run). Most likely the one you meant.

**Pitch:** "Run a team of AI agents on your computer" using the ChatGPT, Claude, Gemini or Grok plan you already pay for. It's a free desktop app.

- **Approach.** It **wraps existing CLI agents** as teammates: Codex, Claude Code, Grok CLI, Gemini CLI, Cursor CLI, OpenCode, custom OpenAI-compatible endpoints, custom ACP agents, and auto-detected Ollama and LM Studio. It talks to them over stdio (JSONL / stream-JSON).
- **Workspaces.** `~/OpenBot/Agents/<id>` per agent, `~/OpenBot/Shared` for cross-agent files, and `Shared/Transfers` for managed snapshots with `.openbot-transfer.json` manifests.
- **Collaboration.** Agent-to-agent messages with replies, reactions, images and file transfers. **Channels** have *one task owner, explicit delegation and shared history*, with Stop / Resume / Reassign / Archive / Restore.
- **Queues.** FIFO message queues per agent with pause, resume, cancel and crash-safe persistence.
- **Browser and computer.** A persistent embedded browser that agents open, inspect and control. Optional OS-level computer use via `cua-driver`.
- **Context.** Per-agent context monitoring with **automatic compaction** before the window fills.
- **Team and mobile.** WebRTC team sharing (the signal server only does setup) and an Expo mobile app.
- **Stack.** Electron + SolidJS, a SQLite command log with read projections (event-sourced), Bun and TypeScript. A Cloudflare Workers account API is optional.
- **Safety: none by design.** Agents run with `danger-full-access` and `approvalPolicy: never`. "Full local access is an explicit current product decision, not a security boundary."
- **License: PolyForm Noncommercial 1.0.0** (since v0.1.11; earlier versions were Apache-2.0). That **is not OSI open source**: commercial use needs a separate licence.

Sources: [GitHub](https://github.com/nightly-labs/openbot) · [openbot.run](https://openbot.run/)

### 3b. CopilotKit/OpenBot (MIT, ~5.8k stars, alpha)

**Pitch:** Open-source AI coworkers with isolated virtual computers and real governance. A self-hosted template.

- **Isolation.** **Each bot gets its own Docker container**, with optional gVisor `runsc`. Each has its own `/workspace`, Chromium profile and login credentials. Computers bind to `127.0.0.1` with per-container tokens.
- **Governance gateway (fail-closed).** Every tool call is evaluated against **CEL policies** before it runs. Policies can inspect the tool name, URL or domain, file path, arguments and *initiator* (human vs. scheduled).
- **Audit ledger.** Every permitted, refused and failed action is recorded, with secrets redacted (`/admin/audit`).
- **"Take the wheel".** At 2FA, a CAPTCHA or a risky step, the agent pauses and you drive its browser directly, then hand back.
- **Framework-agnostic via AG-UI.** Bring agents from LangGraph, CrewAI, Mastra, Pydantic AI or your own code. **Generative UI**: replies can be React components such as dashboards and forms.
- **Stack.** React/Vite, a Hono API, Postgres, a browser supervisor, encrypted write-only credentials, Docker Compose.

Sources: [GitHub](https://github.com/CopilotKit/OpenBot) · [DEV article](https://dev.to/terminalchai/openbot-open-source-ai-coworkers-with-isolated-virtual-computers-and-real-governance-451b)

## 4. Manus 2.0 + Cue

- **Cascade harness.** Loads specialist capabilities only when needed. Manus reports 23% fewer tokens, 28% faster and 32% cheaper.
- **Cloud Computer.** A paid, dedicated, always-on environment for automations and hosted apps or games.
- **Automations.** Event-triggered: new email, Slack message, calendar event, Notion update, ad-performance change.
- **Remote computer use.** It can drive your own machine, and you can watch from your phone.
- **Cue** (a separate app, invite-only and free in early access). **Every agent gets its own email address, phone number, wallet (spends within a budget you set) and computer.** Agents work in **group chats**, handing work to each other toward a shared goal, and the human "sets direction and makes the final call". Because each agent has its own identity, a compromised agent doesn't hand over your inbox. Manus hasn't documented what an agent may say *as you* or per-transaction approvals.

Sources: [Bloomberg](https://www.bloomberg.com/news/articles/2026-09-28/manus-expands-ai-tools-in-renewed-push-into-agent-market) · [CellCog](https://cellcog.ai/blog/manus-2-0/) · [NerdHeadz on Cue](https://www.nerdheadz.com/blog/manus-cue-personal-ai-agents-explained) · [TestingCatalog](https://www.testingcatalog.com/manus-2-0-launches-with-studio-cloud-computer-and-cue/)

## 5. Meta Muse

- **Muse Secure VM per user.** Full Chromium, a Debian runtime, storage, concurrent subagents and cron jobs.
- **Isolation design worth copying.** The agent runs in an **unprivileged systemd-nspawn container**, cut off from credential storage. A separate **Sentinel agent** on the same machine, isolated at the system level, approves **all internet egress**: nothing Muse does reaches the internet without Sentinel's approval, and Sentinel asks the person when needed.
- **Credentials.** Muse never sees passwords or payment methods. They live in secure storage.
- **Payments.** One-time virtual cards via **Stripe Link**. Shop Pay and 1Password are coming.
- **Surfaces.** WhatsApp plus iOS, Android and web. AI glasses are coming.
- **Memory.** It remembers what matters, and you can tell it to **forget** specific things.
- **Planned: Muse Confidential VM.** The whole VM is encrypted with a key only the user holds, so even Meta can't read it.

Sources: [Meta newsroom](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/) · [MarkTechPost](https://www.marktechpost.com/2026/09/08/meta-introduces-muse-a-personal-ai-agent-that-runs-on-its-own-dedicated-secure-cloud-computer/)

## 6. OpenClaw (MIT, the open-source incumbent)

- **What it is.** A self-hosted personal agent whose UI is the **messaging apps you already use**: Signal, Telegram, Discord, WhatsApp and many more (about 29 channels).
- **Skills.** Folders containing `SKILL.md`, plus a community skill hub.
- **Runs locally** with persistent config and history. Supports Claude, GPT, DeepSeek and others.
- **Adoption.** About 247k GitHub stars by March 2026. Tencent and Z.ai shipped OpenClaw-based services. The **OpenClaw Foundation** has stewarded it since the creator joined OpenAI (Feb 2026). v2.0 shipped on Aug 30, 2026.
- **Its lessons are mostly about security.** Prompt injection. A third-party skill caught doing **data exfiltration** (Cisco). **Secrets stored unencrypted at rest** (still true in 2.0). No sandbox isolation by default. An agent created a dating profile without being told to. Chinese agencies and banks were barred from using it.

Sources: [Wikipedia](https://en.wikipedia.org/wiki/OpenClaw)

## 7. Hermes Agent (Nous Research, MIT)

- **Self-improving skills.** After complex tasks it **writes reusable skills automatically, and patches them** when they fall short.
- **Memory.** FTS5 full-text search across past sessions with LLM summaries, plus **Honcho** user modelling (a persistent model of your preferences and style).
- **Tools.** 40+ built-in tools, an MCP client, any provider (OpenRouter's 200+ models, OpenAI, Anthropic, Nous Portal), five execution backends and 7+ chat channels.
- **Caution.** Research is already flagging "skill misevolution": self-improving agents learning unsafe habits ([arXiv 2608.12851](https://arxiv.org/pdf/2608.12851)). Skill changes need a review gate.

Sources: [Agentic AI KB](https://agentic-ai.readthedocs.io/en/latest/AgentPlatforms/hermes-agent/) · [TrueFoundry](https://www.truefoundry.com/blog/what-is-hermes-agent)

## 8. Others worth knowing

- **Perplexity Computer** (Feb 2026, $200/mo Max). Orchestrates **19 models**, subagents, background tasks, browser automation, and Gmail, Slack, Notion and Calendar connectors. A "Personal Computer" on a Mac mini is its local extension. → [VentureBeat](https://venturebeat.com/technology/perplexity-launches-computer-ai-agent-that-coordinates-19-models-priced-at)
- **Google Gemini Spark.** A 24/7 personal agent on dedicated Google Cloud VMs, native to Workspace. → [overview](https://dev.to/amananandrai/14-personal-ai-agents-in-2026-a-technical-guide-to-architecture-memory-tools-autonomy-10h)
- **Anthropic**
  - *Claude Managed Agents* (Apr 2026). Hosted agent runtime: each **session** is an isolated Linux container (bash, Python, Node, writable filesystem). **Environments** define the sandbox. **Vaults** inject secrets as env vars. **Outcomes** give the agent a rubric to work toward. Also memory, schedules and session threads for multi-agent work. → [docs](https://platform.claude.com/docs/en/managed-agents/overview) · [what's new](https://claude.com/blog/whats-new-in-claude-managed-agents)
  - *Claude Code Agent Teams*. A **lead** spawns named **teammates** (peer sessions with their own context) that coordinate through a **shared task list with dependencies** and a **mailbox** for direct messages. This is the cleanest published coordination model. → [guide](https://www.kimi.ai/resources/agent-teams-in-claude-code)
  - *Claude Cowork*. Give Claude a folder and multi-step tasks, and it works in a sandboxed VM.
- **Microsoft Agent 365 + Entra Agent ID.** An **agent registry** plus a **first-class identity per agent**, with conditional access, lifecycle management and "blueprints" (identity templates). This is where enterprise agent identity is going. → [Microsoft Learn](https://learn.microsoft.com/en-us/entra/agent-id/agent-registry-convergence)
- **Block Buzz** (Jul 2026, Apache-2.0). A workspace where **humans and agents are the same kind of member**: each has a secp256k1 keypair, profile, presence, DMs and channels. **Every message, approval and git event is a signed Nostr event in one log**, and an agent's events carry a **second signature tying them to its human owner**. → [Techstrong](https://techstrong.ai/features/block-open-sources-buzz-giving-ai-agents-their-own-identity-inside-the-workspace/) · [Developers Digest](https://www.developersdigest.tech/blog/buzz-block-agent-native-messaging-nostr)

---

## 9. Building blocks for an open-source version

### The computer (sandbox runtimes)

| Option | Isolation | GUI desktop | Persistence | Self-host / license |
|---|---|---|---|---|
| **Docker + gVisor (`runsc`)** | Container + user-space kernel | Bring your own (XFCE + noVNC) | Volumes | ✅ open source. Easiest start (CopilotKit OpenBot uses it) |
| **E2B** (+ E2B Desktop) | Firecracker microVM | ✅ XFCE + VNC | Pause with memory intact, no expiry | ✅ Apache-2.0 core |
| **Cua** | Linux and Windows VMs, `cua-driver` | ✅ desktop pools | Varies | ✅ open source (used by nightly OpenBot) |
| **OpenComputer** | KVM VM | ✗ | Filesystem snapshot, 8h cap | ✅ Apache-2.0 |
| **Firecracker / Kata** directly | microVM | DIY | DIY | ✅ most work, strongest isolation |
| Daytona | Containers (VM optional) | ✅ Xvfb + noVNC | VM only | ⚠️ production codebase went closed source in June 2026 |
| Modal, Vercel Sandbox, Fly Sprites | gVisor / Firecracker | ✗ | Limited | ✗ hosted only |

Reference price: a 2 vCPU / 4 GB box for 1 hour costs about $0.17 on E2B or Daytona. → [comparison](https://dev.to/saptadev27/cloud-computers-for-ai-agents-in-2026-a-practical-comparison-5dbd) · [sandboxing guide](https://amux.io/guides/ai-agent-sandboxing/)

### Protocols (all open, mostly under the Linux Foundation's Agentic AI Foundation, AAIF, founded Dec 2025)

- **MCP**: agent ↔ tools and data. Table stakes.
- **A2A v1.0** (production-ready Jan 2026): agent ↔ agent across vendors. Covers *Agent Cards* (capabilities and endpoints), task delegation and streaming. **None of the products above document A2A support.** That's an opening.
- **AG-UI** (CopilotKit): agent ↔ frontend. Covers streaming, shared state, human-in-the-loop and generative UI.
- **ACP** (Agent Client Protocol): a client driving coding agents (Claude Code, Codex and others) as subprocesses. nightly OpenBot uses it to wrap CLIs.
- **SKILL.md** folders: the de facto skill format (Claude, OpenClaw).

→ [protocol overview](https://atlan.com/know/agent-interoperability-protocols/) · [A2A security analysis](https://arxiv.org/pdf/2609.10871)
