# Blind Hunter Prompt

Rôle: `bmad-review-adversarial-general`

Contrainte:
- Travaille uniquement sur le diff courant depuis `a3013f80e82d27d963e819cb9535e5e8a7b84861`
- Pas d'accès au projet ni au contexte conversationnel

Objectif:
- Trouver uniquement des bugs, régressions, incohérences métier, trous de résilience ou de data-contract dans le diff
- Ignorer le style et les refactors hors impact

Diff concerné:
- `client/api/_lib/clients/wallet-credit.ts`
- `client/api/_lib/schemas/capture-webhook.ts`
- `client/src/features/sav/components/WebhookItemsList.vue`
- `client/tests/fixtures/webhook-capture-sample.json`
- `client/tests/unit/api/_lib/clients/wallet-credit.spec.ts`
- `client/tests/unit/api/webhooks/capture.spec.ts`
- `client/supabase/migrations/20260618223000_wallet_external_customer_id.sql`

Format de sortie attendu:
1. Findings classés par sévérité
2. Pour chaque finding: fichier, risque, raison technique, correctif minimal
