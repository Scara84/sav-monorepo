# Acceptance Auditor Prompt

Rôle: auditor d'acceptance

Lis d'abord:
- `spec-wallet-external-customer-id-wallet-response-validation.md`

Puis audite le diff courant sur:
- `client/api/_lib/clients/wallet-credit.ts`
- `client/api/_lib/schemas/capture-webhook.ts`
- `client/src/features/sav/components/WebhookItemsList.vue`
- `client/tests/fixtures/webhook-capture-sample.json`
- `client/tests/unit/api/_lib/clients/wallet-credit.spec.ts`
- `client/tests/unit/api/webhooks/capture.spec.ts`
- `client/supabase/migrations/20260618223000_wallet_external_customer_id.sql`

Objectif:
- vérifier les écarts à la spec
- vérifier les AC et contraintes
- signaler les points non couverts ou seulement partiellement traités

Format de sortie attendu:
1. Violations des AC
2. Violations de contraintes
3. Gaps de vérification
4. Verdict
