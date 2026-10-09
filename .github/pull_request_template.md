## What this changes

<!-- What and why, in a few sentences. Link the issue it closes: "Closes #123". -->

## How I checked it

<!-- Tests added or run, and what you tried in the app (with TEAMBOT_OFFLINE_MODELS=1 or a real model). Screenshots for UI changes. -->

## Checklist

- [ ] `pnpm typecheck` and `pnpm test` pass
- [ ] New behaviour has a test (see "Testing approach" in CLAUDE.md)
- [ ] User-visible changes have an entry under **Unreleased** in `CHANGELOG.md`
- [ ] Docs are updated where the change shows (see the table in CONTRIBUTING.md → Documentation)
- [ ] Changes under `computer/` were checked against a rebuilt image (`pnpm computer:build`)
