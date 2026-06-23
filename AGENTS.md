# BMAD Low-Cost Mode

This project uses BMAD Method with a token-efficient workflow.

- Always follow [.bmad/low-cost-mode.md](./.bmad/low-cost-mode.md).
- Default workflow: `create-story` -> `dev-story` -> `code-review`.
- Use the smallest sufficient context.
- Do not load the full repository unless required.
- Do not load the full PRD or architecture unless required.
- Prefer targeted file reads and document shards.
- Keep responses concise and diffs minimal.
- Avoid unrelated refactors.
- Run targeted tests first.
- Escalate to stronger reasoning only for architecture, security, auth, payments, permissions, migrations, multi-module refactors, difficult debugging, or critical review.
