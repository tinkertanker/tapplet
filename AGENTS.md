# Agent Guide

- Preserve behaviour and API-contract consistency across the SwiftUI iPad app,
  Cloudflare Worker, D1/R2 storage, scripts, seed corpus and evaluations when a
  change crosses product boundaries.
- Treat `apps/ipad/Resources/Examples` as the one canonical curated corpus.
  Generate tooling fixtures from it with `npm run examples:package`.
- Source identities use Tapplet. Deployed Worker URLs/names, D1/R2 resources,
  bindings, bundle IDs, Swift types and externally configured secret names stay
  stable unless the task explicitly includes a coordinated migration.
- Teacher-facing names: the iPad app is Tapplet Studio; the student-facing HTML
  activities are tapplets.
- Spell code identifiers the US way, as the platform APIs do (`normalize`,
  `color`), unless they mirror a wire name such as `model-catalogue`. Prose
  and user-facing text stay British.
- Keep state derived where possible. Reuse the shared hooks, components,
  styles and network infrastructure rather than duplicating them.
- Use explicit types and avoid `any`. Do not edit generated files without
  changing their source of truth.
- For first-party product UI, follow the colour roles and accessibility
  constraints in [`docs/DESIGN.md`](docs/DESIGN.md).
- Add or update focused tests for behaviour changes and run the narrowest useful
  verification before finishing.
- Do not discard unrelated worktree changes. Keep commits atomic and stage
  files explicitly.
- Keep topic-specific documentation in [`docs/`](docs/).
