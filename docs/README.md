# TeamBot documentation

Start with the guide that matches what you want to do. Every guide is written against the code in this repository; where a guide and the code disagree, the code wins (and please open an issue).

## Use TeamBot

| Guide | Read it when you want to… |
|---|---|
| [Getting started](guides/getting-started.md) | install TeamBot, create a first team and give it work |
| [Action policy](guides/action-policy.md) | decide what agents may do on their own, what needs your approval and what they may never do |
| [Routines and triggers](guides/routines-and-triggers.md) | run an agent on a schedule, or when a webhook, email, Slack message or calendar event arrives |
| [Skills and memory](guides/skills-and-memory.md) | teach agents procedures (by writing them or by showing them) and control what they remember |
| [Connectors, MCP and chat apps](guides/connectors.md) | give agents Notion, GitHub, Linear and other apps, local MCP servers, or reach them from Telegram and Slack |
| [Pages and components](guides/pages-and-components.md) | write documents with agents, comment and @mention them, and build interfaces agents can draw in chats |
| [Deployment](guides/deployment.md) | run TeamBot for a team on a server: sign-in, HTTPS, isolation, backups and upgrades |
| [Troubleshooting](guides/troubleshooting.md) | find out why an agent doesn't start, can't reach a site, keeps asking for approval, and more |

## Understand how it works

| Document | What's in it |
|---|---|
| [Project guide](PROJECT_OVERVIEW.md) | The full, code-level explanation: architecture, the agent loop, routing, tools, computers, policy, secrets, durability and the API |
| [Feature map and roadmap](FEATURE_MAP.md) | How TeamBot compares with Grok Bot, Dots, Cue and the open-source projects, what was built when, and what comes next (P2) |
| [Design](../design.md) | The web app's visual system and UI conventions |
| [P0/P1 review](P0_P1_REVIEW.md) | The review done when P0 and P1 were finished (historical) |
| [Research](research/landscape.md) | The market research behind the feature map |

## Contribute

| Document | What's in it |
|---|---|
| [Changelog](../CHANGELOG.md) | What changed, release by release (everything so far is unreleased; the first release will be 0.1.0) |
| [Contributing](../CONTRIBUTING.md) | Setup, the safety invariants every change must keep, conventions, tests, CI and pull requests |
| [CLAUDE.md](../CLAUDE.md) and [AGENTS.md](../AGENTS.md) | Short orientation for coding agents working in this repository (also a useful map for people) |
