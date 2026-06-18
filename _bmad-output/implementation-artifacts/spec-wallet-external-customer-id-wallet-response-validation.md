---
title: 'Wallet: external customer id et validation de réponse API'
type: 'bugfix'
created: '2026-06-18T22:15:00+02:00'
status: 'in-review'
baseline_commit: 'a3013f80e82d27d963e819cb9535e5e8a7b84861'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Le crédit wallet après validation SAV utilise encore `members.pennylane_customer_id`, qui correspond à l’identifiant interne Pennylane (`customer.id`) et non à l’identifiant client métier visible dans la facture (`customer.external_reference`). Dans le cas observé, l’appel wallet part en `HTTP 200` avec body `User does not exist`, est enregistré comme `sent`, et ne remonte aucun warning opérateur alors qu’aucun crédit réel n’a été appliqué.

**Approach:** Persister l’identifiant client métier Pennylane dans `members`, l’alimenter dès la capture SAV depuis `customer.external_reference`, puis faire consommer ce champ par le client wallet à la place de l’identifiant interne. En parallèle, durcir l’interprétation de la réponse wallet pour qu’un `200` transportant un échec métier soit traité comme `failed` et remonté au front opérateur.

## Boundaries & Constraints

**Always:** Conserver le déclenchement wallet après email `sav_validated` réussi sans remettre l’email en cause; rester sur un lot strictement lié au wallet et au flux de capture de l’identifiant client; préserver l’idempotence `wallet_credit_events`; préférer `customer.external_reference` quand disponible et ne garder `customer.id`/`pennylane_customer_id` qu’en fallback contrôlé si nécessaire pour rétrocompatibilité; journaliser la vraie cause d’échec wallet dans `wallet_credit_events` et remonter un warning opérateur explicite.

**Ask First:** Si la source canonique du wallet doit finalement être un autre champ que `customer.external_reference`; si la migration doit backfiller en masse des membres historiques à partir d’une source externe hors repo.

**Never:** Refactorer le flux complet de capture SAV hors besoin de ce correctif; changer la sémantique globale de validation SAV; masquer un échec métier wallet derrière un statut `sent`; introduire une dépendance temps réel à Pennylane au moment du crédit wallet.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| ID_METIER_CAPTURE | Capture SAV avec `customer.external_reference=9373` et `customer.id=115552207` | le member persiste l’identifiant métier wallet attendu; le flux wallet ultérieur cible `9373` | si `external_reference` absent, conserver un fallback explicite et traçable |
| WALLET_SUCCESS | SAV validé, email envoyé, wallet répond succès métier réel | `wallet_credit_events.status='sent'`, warning vide côté front | N/A |
| WALLET_FALSE_SUCCESS | wallet répond `HTTP 200` avec body `User does not exist` | event marqué `failed`, warning opérateur retourné, aucun faux `sent` | stocker le body de réponse et une cause métier exploitable |
| WALLET_ID_MISSING | member sans identifiant wallet exploitable | aucun call wallet, event `failed`, warning opérateur explicite | journaliser l’absence d’identifiant |

</frozen-after-approval>

## Code Map

- `client/src/features/sav/components/WebhookItemsList.vue` -- construit le payload de capture depuis la facture Pennylane; persiste aujourd’hui `customer.id` comme `pennylaneCustomerId`
- `client/api/_lib/schemas/capture-webhook.ts` -- contrat Zod du payload capture; doit accepter le champ métier supplémentaire
- `client/api/webhooks/capture.ts` -- relaye le payload validé vers la RPC `capture_sav_from_webhook`
- `client/supabase/migrations/20260419120000_initial_identity_auth_infra.sql` -- définit le schéma actuel `members` avec `pennylane_customer_id` seulement
- `client/supabase/migrations/20260421150000_rpc_capture_sav_from_webhook.sql` -- UPSERT member depuis la capture; persiste aujourd’hui seulement `pennylane_customer_id`
- `client/api/_lib/clients/wallet-credit.ts` -- choisit l’identifiant wallet, appelle l’API WordPress et interprète la réponse
- `client/tests/unit/api/_lib/clients/wallet-credit.spec.ts` -- verrouille les cas succès/échec du client wallet
- `client/tests/unit/api/webhooks/capture.spec.ts` -- verrouille le payload transmis à la RPC
- `client/tests/integration/rpc/capture-sav-from-webhook.spec.ts` -- point d’entrée si on veut couvrir la persistance réelle DB du nouveau champ

## Tasks & Acceptance

**Execution:**
- [x] `client/supabase/migrations/20260618223000_wallet_external_customer_id.sql` -- ajouter un champ `members.external_customer_id` et recréer la RPC de capture pour persister `customer.external_reference` sans casser les members existants -- le wallet a besoin d’une source persistée fiable
- [x] `client/api/_lib/schemas/capture-webhook.ts` + `client/src/features/sav/components/WebhookItemsList.vue` -- faire traverser l’identifiant métier Pennylane du front capture jusqu’à la RPC -- aujourd’hui l’UI facture l’affiche déjà mais le backend ne le reçoit pas
- [x] `client/api/_lib/clients/wallet-credit.ts` -- utiliser `external_customer_id` comme source principale de l’ID wallet et reclasser les faux succès métier (`HTTP 200` + body d’erreur) en `failed` avec warning front -- c’est le défaut fonctionnel observé en preview
- [x] `client/tests/unit/api/_lib/clients/wallet-credit.spec.ts` -- couvrir source d’ID métier, fallback éventuel, et faux succès `User does not exist` -- verrouiller la non-régression du client wallet
- [x] `client/tests/unit/api/webhooks/capture.spec.ts` et test ciblé capture associé -- vérifier que le payload capture transmet bien l’identifiant métier attendu jusqu’à la RPC -- éviter que la correction UI reste non persistée

**Acceptance Criteria:**
- Given une facture Pennylane avec `customer.external_reference`, when un SAV est capturé, then le member créé ou réutilisé stocke cet identifiant métier pour un usage wallet ultérieur
- Given un SAV validé dont l’email `sav_validated` a été envoyé, when le crédit wallet se déclenche, then l’appel wallet utilise l’identifiant client métier persistant et non l’identifiant interne Pennylane
- Given une réponse wallet `HTTP 200` contenant un échec métier comme `User does not exist`, when le client wallet traite la réponse, then `wallet_credit_events` est marqué `failed` et un warning opérateur est renvoyé au front
- Given un member sans identifiant wallet exploitable, when le crédit wallet est tenté, then aucun faux succès n’est enregistré et l’opérateur reçoit un message d’erreur explicite

## Spec Change Log

## Design Notes

Le correctif se découpe en deux axes qu’il faut livrer ensemble pour être utile:

1. Source d’identité
   Le problème n’est pas dans le déclenchement du cron mais dans la nature de l’ID transmis au wallet. L’UI facture montre déjà que `external_reference` porte l’ID métier (`9373`) alors que `customer.id` vaut `115552207`. Sans persistance dédiée, le wallet client ne peut pas retrouver le bon identifiant.

2. Interprétation de réponse
   Le wallet ne doit pas être piloté uniquement par `response.ok`. Une réponse métier négative encapsulée dans un `200` doit être traitée comme un échec observé, pas comme un succès nominal.

Exemple attendu de persistance capture:

```json
{
  "customer": {
    "pennylaneCustomerId": "115552207",
    "externalCustomerId": "9373"
  }
}
```

## Verification

**Commands:**
- `cd client && volta run --node 22 npm run test -- --run tests/unit/api/_lib/clients/wallet-credit.spec.ts tests/unit/api/webhooks/capture.spec.ts` -- expected: les nouveaux cas ID métier + faux succès wallet passent
- `cd client && volta run --node 22 npm run test -- --run tests/unit/api/cron/retry-emails.spec.ts tests/unit/api/sav/status.v1-13.spec.ts src/features/back-office/views/SavDetailView.edit.spec.ts` -- expected: aucune régression sur la propagation des warnings wallet

**Manual checks (if no CLI):**
- Rejouer une capture/facture où `customer.external_reference` est visible dans l’UI et vérifier que le member stocke ce champ
- Revalider un SAV en preview et confirmer qu’un faux succès wallet ne produit plus `status='sent'` silencieux
