# Contributing to TeamBot

Thank you for your interest in contributing to TeamBot! TeamBot is an open-source office for AI agents where each agent gets its own computer and model, and works with people and other agents in chats and group chats under configurable governance rules.

This document outlines guidelines and workflows for contributing to TeamBot.

---

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Before You Begin](#before-you-begin)
- [Development Setup](#development-setup)
- [Repository & Monorepo Structure](#repository--monorepo-structure)
- [Architecture & Safety Safeguards](#architecture--safety-safeguards)
- [Coding Conventions & Style](#coding-conventions--style)
- [Testing & Verification](#testing--verification)
- [Continuous Integration & Releases](#continuous-integration--releases)
- [Documentation](#documentation)
- [Pull Request & Commit Guidelines](#pull-request--commit-guidelines)
- [Reporting Security Issues](#reporting-security-issues)

---

## Code of Conduct

We are committed to providing a welcoming, inclusive, and harassment-free environment for everyone. Please treat all maintainers and fellow contributors with respect, empathy, and professional courtesy.

---

## Before You Begin

1. **Check the Roadmap:** Consult [`docs/FEATURE_MAP.md`](docs/FEATURE_MAP.md) before proposing or implementing new features. P0 and P1 are complete, and P2 priorities are outlined there.
2. **Review UI Guidelines:** If your contribution involves the web user interface, review [`design.md`](design.md) for the design system tokens, layout conventions, and component patterns.
3. **Open an Issue:** For significant features or architectural changes, open a GitHub discussion or issue first to align with maintainers before writing code.

---

## Development Setup

### Prerequisites

- **Node.js**: `22.13.0` or higher (uses built-in `node:sqlite`).
- **pnpm**: Version `10` or higher (`packageManager` is set to `pnpm@10.30.2`).
- **Docker**: Docker Desktop (Windows/macOS) or Docker Engine (Linux) for running agent containers.
- **OpenRouter API Key** (optional for mock testing, required for live models): Obtain a key from [OpenRouter](https://openrouter.ai).

### Step-by-Step Setup

1. **Clone the repository:**
   ```bash
   git clone https://github.com/NastyRunner13/teambot.git
   cd teambot
   ```

2. **Install workspace dependencies:**
   ```bash
   pnpm install
   ```

3. **Configure environment:**
   Copy the example environment file:
   ```bash
   cp .env.example .env
   ```
   Add your `OPENROUTER_API_KEY` in `.env`. To develop offline without consuming model credits or requiring an API key, set:
   ```env
   TEAMBOT_OFFLINE_MODELS=1
   ```

4. **Build the agent container image:**
   ```bash
   pnpm computer:build
   ```
   *(Note: This builds the Debian desktop container image with Chromium, Xvfb, and computerd, tagged with the name the server uses by default (`ghcr.io/nastyrunner13/teambot-computer:<version>`) and `teambot/computer:latest`. Without it, the server downloads the published image for its version, which won't have your changes under `computer/`.)*

5. **Run the development environment:**
   ```bash
   pnpm dev
   ```
   This runs the Fastify backend on port `8787` (via `tsx watch`) and Vite dev server on port `5173` (proxied to API). Open `http://localhost:5173`.

6. **Check UI work without touching your workspace (optional):**
   `.claude/launch.json` has a `teambot-verify` configuration: a server on port `8788` with its own data folder and offline models, serving `apps/web/dist`. Run `pnpm build` after UI changes, then start it to click through the change without spending credits.

---

## Repository & Monorepo Structure

```
teambot/
├── apps/
│   ├── server/           # Fastify backend, runtime loop, policy engine, computers, vault, tools
│   └── web/              # React 19 + Vite frontend (Zustand v5, wouter, vanilla CSS)
├── computer/             # Debian Docker container image, Xvfb, Chromium CDP, and computerd daemon
├── packages/
│   └── shared/           # Shared TypeScript domain models and contract types
├── docs/                 # Architectural specifications, feature map, and research notes
├── .env.example          # Template configuration
└── package.json          # Root workspace configuration
```

- **`packages/shared/src/`**: Shared types consumed directly as TypeScript source without a build step.
- **`apps/server/src/`**: Server backend. NodeNext ESM resolution (server relative imports require `.js` extensions).
- **`apps/web/src/`**: React web application using Bundler resolution (imports omit `.js`).
- **`computer/computerd/`**: HTTP tool daemon running inside each agent container.

---

## Architecture & Safety Safeguards

When writing code that interacts with models, tools, or user data, you must maintain TeamBot's safety invariants:

1. **Policy-Gated Execution:**
   - Every agent tool call passes through the policy engine (`apps/server/src/policy.ts`).
   - The strictest matching decision applies: `deny > handoff > ask > review > allow`.
   - Never bypass the policy check when executing tool actions.

2. **Secret Scrubbing & Isolation:**
   - Secrets are encrypted with AES-256-GCM using `TEAMBOT_MASTER_KEY` (`apps/server/src/vault.ts`).
   - Secrets referenced via `{{secret:NAME}}` are substituted at execution time and redacted from command output.
   - Secret values must never appear in transcripts, model prompts, or screenshots.
   - Secret names starting with `TEAMBOT_` are reserved for internal infrastructure.

3. **Prompt Injection Tagging:**
   - All external/untrusted content (web pages, files, command output, webhook bodies, emails) must be wrapped in `<untrusted_content>` tags before reaching model prompts.

4. **Private DM Access Control:**
   - Direct messages between users and agents must remain private.
   - Always route message, event, and run retrieval through `workspace.canSee(channel, viewerId)`.
   - Human actions must be attributed to `me(req)` (resolved via session cookie in team mode, or workspace owner in single-user mode).

5. **Append-Only Migrations:**
   - SQLite migrations in `apps/server/src/store.ts` are strictly append-only.
   - Never edit, reorder, or delete existing migration entries in `MIGRATIONS`.

6. **Interrupted Tool Execution:**
   - Tools interrupted mid-flight must be recorded as explicit failures or "interrupted".
   - Never silently re-run interrupted tool executions on server recovery.

7. **Sandboxed Interfaces:**
   - Components and agent-drawn interfaces run in `WidgetFrame` with `sandbox="allow-scripts"` and a CSP with `connect-src 'none'`. Never add `allow-same-origin`.
   - The API refuses non-GET requests with `Origin: null`; keep that check.

8. **Read-only Runs:**
   - Read-only runs are offered only tools with risk `read` or `readOnlyOk: true`. Never set `readOnlyOk` on a tool that changes memory, agents or anything outside the run.

9. **Live Updates Need Events:**
   - A server-side state change only reaches open browsers if it emits a `bus` event the web store handles. New kinds of model calls must emit cost events, or budgets won't see them.

---

## Coding Conventions & Style

- **Language:** Strict TypeScript throughout.
- **Formatting:** Two-space indentation, single quotes (`'`), semicolons (`'always'`).
- **Naming Conventions:**
  - PascalCase for React components and filenames (`ChatView.tsx`, `ApprovalCard.tsx`).
  - camelCase for functions, methods, and variables.
  - kebab-case for server modules and utility files (`shared-files.ts`, `coding-tools.ts`).
- **Imports:**
  - Server imports: Use `.js` extension for relative imports (`import { App } from './app.js';`).
  - Web imports: Omit file extensions for TS/TSX modules (`import { useStore } from '../store';`).
- **React & State Management:**
  - Zustand v5: Ensure selectors return stable references or use `useShallow` to prevent infinite re-render loops.
  - Dialogs: Use `data-autofocus` attribute on initial fields rather than HTML `autoFocus`.
  - Effects: give effect bodies braces (`useEffect(() => { el.scrollIntoView(); })`). An arrow that returns a promise becomes React's cleanup and blanks the app.
- **Validation:** zod `.partial()` keeps `.default()` values, so never build a PATCH schema from a create schema with defaults (see `agentFields`/`scheduleFields` in `api.ts`).
- **Heavy dependencies:** load optional or large libraries lazily with `await import(...)` (the MCP SDK, imapflow, mailparser and ical.js already are).

More pitfalls, with the reasons behind them, are listed under "Gotchas" in [`CLAUDE.md`](CLAUDE.md).

---

## Testing & Verification

All automated tests live in `apps/server/test/` and run via Vitest.

### Running Tests

```bash
# Run unit and runtime integration tests
pnpm test

# Run a focused test suite
pnpm --filter @teambot/server exec vitest run test/policy.test.ts

# Run a single test case
pnpm --filter @teambot/server exec vitest run test/runtime.test.ts -t "answers a DM"

# Run typechecks across all packages
pnpm typecheck

# Build the web application bundle
pnpm build
```

### Docker Integration Tests

To run integration tests against a live Docker container:
1. Ensure Docker is running.
2. Build the computer image: `pnpm computer:build`.
3. Run with `TEAMBOT_DOCKER_TESTS=1`:
   ```bash
   TEAMBOT_DOCKER_TESTS=1 pnpm test
   ```

### Writing Deterministic Tests

- Use `testApp()` from `apps/server/test/helpers.ts` to spin up an in-memory SQLite database, scripted model responses (`ScriptedProvider`), and `FakeComputers`.
- Always clean up runtimes in `afterEach()` hooks (`await app.runtime.stop()`).
- Drive scenarios by posting messages (`app.workspace.postMessage(...)`), then `await app.runtime.idle()`. Script model replies per agent with `models.script('test/<agentname>', [say(...), callTool(...)])`.
- Test HTTP behaviour with `buildServer(app)` and `server.inject(...)`; team-mode tests keep a cookie per person.
- Time-based sweeps take a time argument (for example `lifecycle.sweep(at)`), so tests never sleep.

---

## Continuous Integration & Releases

GitHub Actions (`.github/workflows/`) runs on every pull request and every push to `main`:

- **CI** (`ci.yml`): `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test`, `pnpm build` on Node 22. A PR must pass it.
- **Docker** (`docker.yml`): builds (without pushing) the server image and the agent computer image when the `Dockerfile`, `computer/`, lockfile or workspace files change.
- **Release** (`release.yml`): pushing a tag like `v0.2.0` runs CI again and checks that the tag matches `version` in `package.json`. It then builds both images for amd64 and arm64 on native runners and pushes them to GitHub's registry as `ghcr.io/nastyrunner13/teambot` and `ghcr.io/nastyrunner13/teambot-computer`, tagged `0.2.0`, `0.2` and `latest`. Last, it publishes a GitHub Release with the source plus the built web app, a SHA-256 checksum, and that version's `CHANGELOG.md` section as its notes. Tags with a suffix (`v0.2.0-rc.1`) become pre-releases and don't move `latest`.

The server's default computer image is the one tagged with its own version (`DEFAULT_COMPUTER_IMAGE` in `apps/server/src/config.ts`), and it downloads that image when it's missing, so a server and its computers always come from the same release. It only ever downloads images under `ghcr.io/nastyrunner13/teambot-computer`: any other name could belong to anyone, and a computer's image runs privileged commands for its firewall.

To cut a release: move the entries under **Unreleased** in [`CHANGELOG.md`](CHANGELOG.md) into a new `## [0.2.0] - YYYY-MM-DD` section, bump `version` in `package.json`, merge both, then

```bash
git tag v0.2.0
git push origin v0.2.0
```

---

## Documentation

Docs live next to the code they describe and are updated in the same pull request as the behaviour they cover:

| Change | Update |
|---|---|
| Any user-visible change (added, changed, removed, fixed, security) | An entry under **Unreleased** in `CHANGELOG.md` |
| A user-visible feature or setting | `README.md` and the matching guide in `docs/guides/` |
| A new environment variable | `.env.example`, the README configuration table and `docs/PROJECT_OVERVIEW.md` |
| How something works internally | `docs/PROJECT_OVERVIEW.md` and, for invariants coding agents must keep, `CLAUDE.md` |
| Something on the roadmap is built | `docs/FEATURE_MAP.md` (matrix row and a dated section) |
| UI patterns or tokens | `design.md` |

Write plainly: short sentences, the names the UI uses in **bold**, and only behaviour you checked in the code. `docs/README.md` is the index; add new guides there.

---

## Pull Request & Commit Guidelines

### Commit Messages

Use concise, imperative commit subjects (50 characters or less for the title):
- `Add approval resume handling`
- `Fix shared folder link resolution boundary`
- `Implement calendar routine trigger polling`
- `Add model picker budget indicators`

Keep commits atomic and focused on a single feature, refactor, or fix.

### Pull Request Checklist

Before submitting a PR, verify:
- [ ] `pnpm typecheck` passes with zero errors.
- [ ] `pnpm test` passes all unit and integration suites.
- [ ] `pnpm build` succeeds for the web client.
- [ ] New features include corresponding unit tests under `apps/server/test/`.
- [ ] UI changes include before/after screenshots or recordings.
- [ ] Docs are updated for any user-visible change (see [Documentation](#documentation)).
- [ ] `CHANGELOG.md` has an entry under **Unreleased** for any user-visible change.
- [ ] No temporary files, `.env`, `mcp.json`, or `data/` artifacts are committed.

---

## Reporting Security Issues

Security and isolation are critical to TeamBot. If you discover a vulnerability related to:
- Container or sandbox escape
- Secret redaction bypass or leakage
- Prompt injection exploitation
- Authentication or private DM bypass

Please report it privately rather than opening a public issue, for example through a private security advisory on the GitHub repository (Security tab → Report a vulnerability). Include the version or commit, steps to reproduce and the impact you see. We appreciate your assistance in keeping TeamBot secure.
