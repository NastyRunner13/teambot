# Changelog

All notable changes to TeamBot are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Until 1.0, a minor version (0.x.0) may include breaking changes; they are called out under **Changed** or **Removed**.

## [Unreleased]

### Fixed
- Offline model mode now appears as **Offline (echo)** in Settings and no longer shows the missing-key warning; the banner explains how to switch to real models.

## [0.1.0] - 2026-10-10

The first release.

### Added

#### Install with Docker alone (2026-10-10)
- Releases publish the server and agent computer images to GitHub's registry for amd64 and arm64 (Apple silicon included): `ghcr.io/nastyrunner13/teambot` and `ghcr.io/nastyrunner13/teambot-computer`. `docker compose up -d` runs TeamBot without building anything, and `TEAMBOT_VERSION` pins a release.
- The server downloads the computer image for its own version the first time it's needed, with a banner and **Settings → System** showing the download. It never downloads images TeamBot doesn't publish. `pnpm computer:build` tags a local build with the same name, so your own build wins.
- `SECURITY.md` with private vulnerability reporting, a code of conduct, and issue and pull request templates.

#### Documentation (2026-10-06)
- Task-oriented guides in `docs/guides/`: getting started, action policy (with tested rule recipes), routines and triggers, skills and memory, connectors and chat apps, pages and components, deployment, and troubleshooting.
- A documentation index at `docs/README.md`, and this changelog.
- `CONTRIBUTING.md` sections on CI and releases and on keeping docs in step with code. The project guide now covers page comments, file previews and handling of bad model output.

#### Learning by demonstration (2026-10-05, [#10](https://github.com/NastyRunner13/teambot/pull/10))
- **Record** in an agent's Computer tab: do a task in its browser and TeamBot logs the pages, clicks, typing, choices and keys, with stills along the way.
- The utility model drafts a `SKILL.md` from the recording. Drafts are reviewed under **Connect apps → Skills** beside what you did, and no agent sees one until a person saves it.
- Passwords and secret-looking fields are never read. Typed values that match stored secrets become `{{secret:NAME}}` placeholders, and no still is kept of a page where a secret was typed.

#### Comments and @mentions in pages (2026-10-05, [#9](https://github.com/NastyRunner13/teambot/pull/9))
- Comment threads on a passage or a whole page, with replies, **Resolve** and **Reopen**. A thread's passage is found again after edits. If it was edited away, the thread is marked **Outdated** rather than dropped.
- @mentioning an agent in a comment wakes it, and it answers in the thread. `ask_agent` answers come back there too.
- Agent tools `list_page_comments`, `comment_on_page` and `resolve_comment`.

#### CI and releases (2026-10-05, [#5](https://github.com/NastyRunner13/teambot/pull/5))
- GitHub Actions run typecheck, tests and the web build on every pull request and push to `main`, and build both Docker images when their inputs change.
- Pushing a `v*` tag that matches `package.json` publishes a GitHub Release with the source, the built web app and a checksum.

#### Files agents make (2026-10-05, [#4](https://github.com/NastyRunner13/teambot/pull/4))
- An agent's message carries the `/shared` files its text names, so "Saved /shared/report.md" arrives with the file attached.
- Previews of every kind of file an agent makes: Markdown, code, CSV, notebooks, images, audio, video, web pages, Word, Excel, PowerPoint, PDF and Mermaid. Files open beside the chat in a wider panel you can drag.
- Agent computers include python-docx, openpyxl, xlsxwriter, python-pptx, reportlab, pypdf, matplotlib, pandas and pandoc for making documents (build arg `DOCUMENT_TOOLS=0` leaves them out).
- `/api/shared/file` serves files with an etag, size and media type. Previews reload only when a file changes.

#### Pages, generative UI and tool cards (2026-10-04, [#3](https://github.com/NastyRunner13/teambot/pull/3))
- **Pages:** Markdown documents people and agents edit together. Every save checks the revision it started from, so nobody overwrites an edit they never saw. Agent tools: `list_pages`, `read_page`, `create_page` and `edit_page`.
- **Review before saving:** `propose_page` shows a draft in the chat and saves it only on **Approve & save**.
- **Generative UI:** agents draw interfaces in the chat with `show_ui` (off with `TEAMBOT_GENERATIVE_UI=0`), or with published **components** (`ui_<name>`) written in a playground under **Connect apps → Components**. Everything runs in a sandboxed frame with no network and no access to TeamBot.
- **Tool cards:** each action an agent takes shows as a card with what it acted on, how it went and its output.
- **Routines set up by agents:** `create_routine` (reviewed by default, at most every 15 minutes), `list_routines`, `stop_routine` and `resume_routine`.
- Agents see their last five jobs in other conversations, so they can answer "what did you do last time?" from any chat.
- Handoff answers show where they were asked ("Message from …"). After answering, the asked agent writes a short heads-up in its chat with the person the request was for.

#### `ask_agent` handoffs (2026-10-03, [#2](https://github.com/NastyRunner13/teambot/pull/2))
- `ask_agent` hands a teammate a structured request (task, context, constraints, what a good answer looks like). The answer comes back to the conversation that asked, and a request that ends unanswered is reported with the reason.
- `TEAMBOT_MAX_HANDOFFS_PER_RUN` (default 4) limits how many teammates one run may hand work to.
- `browser_screenshot`, so agents on vision models can read charts and tables drawn as images.
- Prompt rules: agents say where an answer came from and report only actions a tool result shows happened.

#### Chat workspace redesign (2026-10-02 to 2026-10-03, [#1](https://github.com/NastyRunner13/teambot/pull/1))
- A chat-first interface: conversations newest first, a panel per agent with Details, Customize, Memory, Library and Computer, and a dark theme by default (Light and Auto too).
- Approvals appear in the conversation where the agent asked. Work notes show a live line while an agent works and "Worked for … · N steps" when it's done.
- A progress checklist per run (`update_progress`), shown live and kept on the finished reply.
- Settings and **Connect apps** share one frame. The app marketplace lists about 35 vendors' MCP servers with OAuth sign-in, and servers like GitHub's take a pasted token.

#### First release scope: P0 and P1 (2026-10-02)
- Named agents, each with its own OpenRouter model, instructions, budget and isolated Docker computer (terminal, files, Chromium) that you can watch live and take control of.
- Channels, DMs, threads, attachments, a `/shared` folder, channel lead agents and an agent-to-agent loop guard.
- The action policy: allow, review, ask, deny or hand off on every tool call, with CEL conditions and an independent reviewer model.
- An encrypted secrets vault with `{{secret:NAME}}` injection and redaction, and untrusted-content tagging against prompt injection.
- Daily and monthly spend caps and daily token caps per agent, plus a workspace cap.
- Durable runs that survive restarts, with interrupted tools reported, never re-run.
- Skills in the SKILL.md format, and memory as plain Markdown files with search across past conversations.
- Routines on a schedule or triggered by webhooks, email (IMAP), Slack messages or calendar events. Read-only routines for monitoring.
- MCP servers from `mcp.json`, Telegram and Slack bridges with approval buttons, and coding agents (Claude Code, Codex, Gemini CLI) inside an agent's computer.
- For agent computers: full desktop control (opt-in), setup scripts, custom base images, idle sleep, snapshots, and per-agent internet allowlists through an egress proxy.
- Team sign-in with invite links and owner/member roles, OpenTelemetry export, and Docker Compose self-hosting.

### Changed
- Agents hand each other work with `ask_agent`. `send_dm` is now only for messaging people.
- A DM stays between the two members it was opened with. Mentioning another agent in your DM with an agent leaves it to that agent to bring them in.
- The Approvals, Activity and Tasks pages were folded into conversations, and old `/approvals`, `/activity` and `/tasks` links redirect.

### Removed
- The task board and task tools (`create_task`, `update_task`, `list_tasks`), and follow-ups on quiet tasks (`TEAMBOT_STALE_TASK_HOURS`). Agents show progress as per-run checklists instead. Old tasks stay in the database as history.
- Temporary helper agents. Agents do their own work and ask an existing teammate when its specialty fits. Migration 16 removes any helpers left over.
- Agent templates in the new-agent dialog (**Create starter team** still adds Lead, Researcher and Writer).

### Fixed
- A calendar routine test depended on the date it ran on and began failing after 2026-10-07.
- Garbled model output (null bytes) is never posted, and two garbled turns in a row fail the run with advice to pick another model. Replies cut off at the output limit are explained to the model instead of being treated as invalid JSON.
- Empty final replies get one nudge, then a note, so a run never finishes in silence.
- Recording keeps working when a browser tab stops answering.
- Agents no longer point at deleted files or old tasks.
- DMs that had gained extra members were repaired, and their empty duplicates merged back.
- From the P0 review: the Routines tab and New task dialog no longer crash, dialogs focus their first field, and partial agent and routine updates no longer reset other fields.

### Security
- Docker Compose no longer names `teambot/server` on Docker Hub, a name TeamBot doesn't own; a `docker compose up` without `--build` would have pulled whatever was published there.
- Recordings drop query values, fragments and token-like path segments from page addresses, so a password sent by a GET form, a `?code=` or an `#access_token=` is never kept. No still is kept of a page whose address carried a stored secret.
- Tool arguments containing null bytes are refused before anything runs.

[Unreleased]: https://github.com/NastyRunner13/teambot/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/NastyRunner13/teambot/releases/tag/v0.1.0
