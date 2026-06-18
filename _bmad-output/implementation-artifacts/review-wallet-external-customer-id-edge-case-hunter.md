# Edge Case Hunter Prompt

Rôle: `bmad-review-edge-case-hunter`

Contrainte:
- Tu peux lire le projet, mais sans contexte conversationnel
- Concentre-toi sur les cas limites, données manquantes, fallback, comportements partiels et faux positifs/faux négatifs

Sujet:
- persistance de `customer.external_reference` vers `members.external_customer_id`
- fallback wallet sur `members.pennylane_customer_id`
- détection des faux succès wallet `HTTP 200`

Fichiers de départ:
- `client/api/_lib/clients/wallet-credit.ts`
- `client/api/_lib/schemas/capture-webhook.ts`
- `client/src/features/sav/components/WebhookItemsList.vue`
- `client/supabase/migrations/20260618223000_wallet_external_customer_id.sql`
- `client/tests/unit/api/_lib/clients/wallet-credit.spec.ts`
- `client/tests/unit/api/webhooks/capture.spec.ts`

Format de sortie attendu:
1. Edge cases non couverts
2. Risques data / rétrocompatibilité
3. Tests manquants concrets
