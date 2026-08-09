# Agent Guide

- Read the relevant code before changing it and follow nearby patterns.
- Prefer the smallest correct change; avoid unrelated refactors and new
  abstractions unless they clearly reduce complexity.
- Keep state derived where possible. Reuse existing shared hooks, components,
  styles, and network infrastructure rather than duplicating them.
- Preserve behavior and API-contract consistency across the SwiftUI iPad app,
  Cloudflare Worker, D1/R2 storage, scripts, seed corpus and evaluations when a
  change crosses product boundaries.
- Treat `apps/ipad/Resources/Examples` as the one canonical curated corpus.
  Generate tooling fixtures from it with `npm run examples:package`.
- Source identities use Tapplet. Deployed Worker URLs/names, D1/R2 resources,
  bindings and externally configured secret names remain stable unless a task
  explicitly includes a coordinated infrastructure migration.
- Use explicit types and avoid `any`. Do not edit generated files without
  changing their source of truth.
- Add or update focused tests for behavior changes and run the narrowest useful
  verification before finishing.
- Do not discard unrelated worktree changes. Keep commits atomic and stage
  files explicitly.
- Keep topic-specific documentation in [`docs/`](docs/). Use
  [`README.md`](README.md) and `package.json` for project setup and commands.
