# Acceptance Auditor Review Prompt

You have read access to the project. Review the implementation against the approved spec and acceptance criteria.

Spec file:

`_bmad-output/implementation-artifacts/spec-automate-supplier-claim-onedrive-fill.md`

Baseline commit:

`69a11aa106cc9b355bf018b104b76011bf49ef3f`

Diff command:

```bash
git diff 69a11aa106cc9b355bf018b104b76011bf49ef3f -- \
  client/README.md \
  client/api/_lib/sav/generate-supplier-claim-handler.ts \
  client/api/_lib/sav/supplier-claim-writer.ts \
  client/api/_lib/sav/supplier-claim-onedrive-fill.ts \
  client/src/features/back-office/composables/useSupplierClaimArbitration.ts \
  client/src/features/back-office/views/SupplierClaimView.vue \
  client/tests/unit/api/sav/generate-supplier-claim.spec.ts \
  client/tests/unit/api/sav/supplier-claim-onedrive-fill.spec.ts \
  client/tests/unit/features/back-office/composables/useSupplierClaimArbitration-onedrive.spec.ts
```

Acceptance criteria to audit:

- Same generated XLSX A:M values are appended into OneDrive `SUIVI_SAV` C:O, after existing rows, without overwriting.
- Graph append failure does not block XLSX generation/download and is visible in UI.
- Missing OneDrive config preserves historical download behavior and does not call Graph.
- Blob response headers expose OneDrive status/link/message to `generateResult`.
- No DB migration or durable history was added.
- Existing supplier claim history and download behavior remain intact.

Return:

1. Acceptance pass/fail summary
2. Findings by severity
3. Missing tests
4. Verdict
