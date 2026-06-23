# BMAD Low-Cost Mode

## Global rules

- Use the smallest sufficient context.
- Never load full project documents unless explicitly required.
- Prefer summaries, document shards, and direct references.
- Avoid repeating unchanged information.
- Keep outputs concise and implementation-focused.
- Ask for or locate only the minimum missing context.
- Use minimal diffs.
- Do not perform broad repository scans unless the targeted approach fails.
- Do not restate long background context already present in PRD, architecture, or story files.
- Prefer referencing source sections instead of copying them.

## Create Story rules

- Use only the relevant epic, PRD excerpt, architecture excerpt, and prior story dependencies.
- Do not load the entire PRD or full architecture by default.
- Create one concise implementation-ready story at a time.
- Do not include long product background.
- Do not duplicate unchanged architecture or PRD text.
- Include only the context needed by the dev agent.

Story output must include:

- Title
- Goal
- Scope
- Acceptance criteria
- Technical notes
- Files likely impacted
- Tests required
- Out of scope
- Definition of done

## Dev Story rules

- Read the story first.
- Identify the minimum set of files required before editing.
- Modify only necessary files.
- Avoid unrelated refactors.
- Prefer small, localized patches.
- Do not scan the whole repository unless targeted inspection fails.
- Do not reopen files already read unless necessary.
- Run targeted tests before full test suites.
- Explain only the essential implementation decisions.

Before editing, list:

- Files to inspect
- Files likely to modify
- Why each file is needed

## Code Review rules

- Review only the current diff, current story, acceptance criteria, and affected contracts.
- Do not re-review the entire codebase.
- Do not restate the whole implementation.
- Report only actionable issues.
- Classify issues as blocker, important, or minor.
- Suggest minimal fixes.
- Do not propose refactors unrelated to the story.

Review output format:

1. Blockers
2. Important issues
3. Minor issues
4. Missing tests
5. Verdict
