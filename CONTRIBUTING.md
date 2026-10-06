# Contributing to TeamBot

Thank you for your interest in contributing to TeamBot! TeamBot is an open-source office for AI agents where each agent gets its own computer and model, collaborating with team members and other agents in channels and on a task board under configurable governance rules.

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
   *(Note: This downloads and builds the Debian desktop container image with Chromium, Xvfb, and computerd).*

5. **Run the development environment:**
   ```bash
   pnpm dev
   ```
   This runs the Fastify backend on port `8787` (via `tsx watch`) and Vite dev server on port `5173` (proxied to API). Open `http://localhost:5173`.

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
- [ ] No temporary files, `.env`, `mcp.json`, or `data/` artifacts are committed.

---

## Reporting Security Issues

Security and isolation are critical to TeamBot. If you discover a vulnerability related to:
- Container or sandbox escape
- Secret redaction bypass or leakage
- Prompt injection exploitation
- Authentication or private DM bypass

Please report it responsibly to the project maintainers rather than opening a public issue. We appreciate your assistance in keeping TeamBot secure.
