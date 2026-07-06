# Blind Hunter Review Prompt

You are reviewing a code diff only. Do not use product context beyond what appears in the diff.

Goal: find concrete bugs, regressions, security issues, data-loss risks, and missing tests. Report only actionable findings with severity and file/line references where possible.

Baseline commit:

`69a11aa106cc9b355bf018b104b76011bf49ef3f`

Run from repo root:

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

Changed/untracked files to include:

```text
M  client/README.md
M  client/api/_lib/sav/generate-supplier-claim-handler.ts
M  client/api/_lib/sav/supplier-claim-writer.ts
A  client/api/_lib/sav/supplier-claim-onedrive-fill.ts
M  client/src/features/back-office/composables/useSupplierClaimArbitration.ts
M  client/src/features/back-office/views/SupplierClaimView.vue
M  client/tests/unit/api/sav/generate-supplier-claim.spec.ts
A  client/tests/unit/api/sav/supplier-claim-onedrive-fill.spec.ts
A  client/tests/unit/features/back-office/composables/useSupplierClaimArbitration-onedrive.spec.ts
```

Return sections:

1. Blockers
2. Important issues
3. Minor issues
4. Missing tests
5. Verdict
