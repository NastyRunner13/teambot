# Security policy

TeamBot runs AI agents with their own computers, controls Docker on its host, and stores secrets for them, so security reports are very welcome. Please report vulnerabilities privately, not in public issues or discussions.

## How to report

Use GitHub's private reporting: **[Report a vulnerability](https://github.com/NastyRunner13/teambot/security/advisories/new)** (the **Security** tab → **Report a vulnerability**). Only the maintainer sees it.

Please include:

- what an attacker can do, and from where (a web page an agent visits, an agent's computer, a teammate's account, the network);
- the version or commit, and how TeamBot was run (from source or Docker Compose, team sign-in on or off);
- steps to reproduce, ideally with a fake model (`TEAMBOT_OFFLINE_MODELS=1` or the scripted provider in `apps/server/test/helpers.ts`) rather than a paid one.

You'll get an answer within a week. Once a fix is released, the advisory is published with credit to you, unless you'd rather stay anonymous.

## Supported versions

TeamBot is pre-1.0. Fixes go into the latest release and `main`; older releases don't get backports. Upgrading is described in [Deployment](docs/guides/deployment.md#upgrade).

## What counts

The [security model](README.md#security-model) describes what TeamBot protects against. Reports that break it are in scope, for example:

- getting out of an agent's computer, into the server, the host or another agent's computer;
- an agent computer reaching the TeamBot API, or getting past its internet allowlist;
- getting past the action policy, an approval, or a read-only run's limits;
- a secret's value reaching a prompt, a transcript, the audit log or another agent, except as described below;
- getting around team sign-in, reading someone else's direct messages, or a member doing what only owners may;
- a widget, file preview or component getting out of its sandboxed frame;
- reading or writing outside `/shared` through the shared folder.

Known limits that the security model already describes are not vulnerabilities on their own:

- an agent that is allowed to use a secret in a shell command can deliberately reveal it;
- prompt injection is reduced by tagging outside content, not prevented; a report is in scope when it gets past the policy or an approval, not when a model merely follows injected text;
- with sign-in off, anyone who can open the page acts as the owner (the server binds to `127.0.0.1` and warns when it doesn't);
- the server controls Docker and is therefore privileged on its host;
- Chromium runs with `--no-sandbox` inside the agent's container.

Never test against a TeamBot you don't run yourself.
