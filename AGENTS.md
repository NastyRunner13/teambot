# Repository Guidelines

## Project structure & module organization

TeamBot is a self-hosted workspace for AI agents with isolated Docker computers.

- `apps/server/src/`: Fastify API, runtime, policy, vault, persistence, and tool integrations.
- `apps/server/test/`: Vitest suites and shared test helpers.
- `apps/web/src/`: React views, reusable components, state, and `styles.css`.
- `packages/shared/src/`: domain types consumed directly as TypeScript.
- `computer/`: container image, startup scripts, and the `computerd` tool API.
- `docs/`: research and roadmap. Check `docs/FEATURE_MAP.md` before proposing features; read `design.md` before UI changes.

## Build, test, and development commands

Use Node.js 22.13+ and pnpm 10. Run commands from the repository root.

- `pnpm install`: install workspace dependencies.
- `pnpm dev`: start the API on port 8787 and Vite on port 5173.
- `pnpm build`: build the web app. The server runs TypeScript through `tsx`.
- `pnpm start`: run the server and serve the built web app.
- `pnpm typecheck`: check server, web, and computerd types.
- `pnpm test`: run server Vitest suites; Docker tests are skipped by default.
- `pnpm computer:build`: rebuild the agent image after changes under `computer/`.

## Coding style & naming conventions

Follow existing TypeScript: two-space indentation, single-quoted strings, semicolons, and strict types. Use PascalCase for React components and their filenames, camelCase for functions and variables, and descriptive kebab-case for multiword server modules. Server relative imports use `.js` extensions under NodeNext; web imports omit them. No formatter or linter is configured.

## Testing guidelines

Name suites `*.test.ts` in `apps/server/test/`. Use `testApp()`, scripted models, and fake computers for deterministic scenarios; stop runtimes during cleanup. Add regression coverage for changed behavior. No coverage threshold is configured.

Run a focused suite with `pnpm --filter @teambot/server exec vitest run test/policy.test.ts`. For Docker integration tests, build the image, start Docker, set `TEAMBOT_DOCKER_TESTS=1` in your shell, then run `pnpm test`.

## Commit & pull request guidelines

No commits exist yet. Use concise, imperative subjects such as `Fix approval resume handling`. Keep changes focused. PRs should describe behavior changes, link relevant issues, report validation, and include screenshots for UI changes. Run typechecking, tests, and the web build before review.

## Configuration & architecture safeguards

Copy `.env.example` to `.env` for local configuration. Keep credentials, `mcp.json`, and runtime `data/` out of commits. Append database migrations; preserve existing entries. Keep tool execution behind policy checks and secret redaction. Interrupted tools must remain explicit failures rather than being silently rerun. Attribute human actions to the signed-in person (`me(req)` in `api.ts`, which is the owner when team sign-in is off), and pass anything that returns messages or events through `workspace.canSee` so people's DMs stay private.
