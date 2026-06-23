# Context Map

Use this file to find the minimum context needed.

## Product

- PRD: `ROADMAP.md`, `SUMMARY.md`, `docs/project-overview.md`
- Epics: `_bmad-output/planning-artifacts/epics.md`
- Stories: `_bmad-output/stories/`

## Architecture

- Overview: `docs/project-overview.md`, `docs/source-tree-analysis.md`
- Frontend: `docs/architecture-client.md`, `client/src/`
- Backend: `docs/integration-architecture.md`, `client/api/`
- Database: `supabase/`, `docs/runbooks/rls-context-binding.md`
- Testing: `docs/development-guide-client.md`, `client/tests/`

## Source Code

- Frontend: `client/src/`, `client/public/`
- Backend: `client/api/`, `supabase/`, `scripts/`
- Shared: `client/shared/`, `client/tests/fixtures/`

## Tests

- Unit tests: `client/tests/`
- Integration tests: `client/tests/integration/`

## Commands

Install:

```bash
cd client && npm install
```

Dev:

```bash
cd client && npm run dev
```

Test:

```bash
cd client && npm run test
```

Integration:

```bash
cd client && npm run test:integration
```

Lint:

```bash
cd client && npm run lint
```

Typecheck:

```bash
cd client && npm run typecheck
```
