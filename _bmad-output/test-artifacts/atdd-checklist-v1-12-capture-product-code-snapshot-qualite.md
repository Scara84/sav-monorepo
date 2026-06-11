---
storyId: v1-12
storyKey: v1-12-capture-product-code-snapshot-qualite
storyFile: _bmad-output/implementation-artifacts/v1-12-capture-product-code-snapshot-qualite.md
atddChecklistPath: _bmad-output/test-artifacts/atdd-checklist-v1-12-capture-product-code-snapshot-qualite.md
stepsCompleted:
  - step-01-preflight-and-context
  - step-02-generation-mode
  - step-03-test-strategy
  - step-04-generate-tests
lastStep: step-04-generate-tests
lastSaved: '2026-06-11'
generatedTestFiles:
  - client/src/features/sav/lib/__tests__/extractProductCode.test.js
  - client/tests/unit/schemas/capture-webhook.product-code.spec.ts
inputDocuments:
  - _bmad-output/implementation-artifacts/v1-12-capture-product-code-snapshot-qualite.md
  - client/src/features/sav/components/WebhookItemsList.vue
  - client/api/_lib/schemas/capture-webhook.ts
  - client/tests/unit/schemas/capture-webhook.spec.ts
  - client/src/features/sav/lib/__tests__/buildCaptureItemPrices.test.js
---

# ATDD Checklist — Story V1.12 Qualité du product_code capturé

## Preflight & Context

- **Stack détecté** : `fullstack` (Vitest unitaire pour TS/JS pur, pas de Playwright pour cette story).
- **Story** : extraction d'un vrai code catalogue (ex. `3010-2K`) à la place du fallback dégradé `productName.slice(0,32)`. Pure logique de string ; aucune DB, aucun trigger, aucun endpoint nouveau.
- **Frameworks détectés** : Vitest (`client/vitest.config.ts`), pattern test existant `buildCaptureItemPrices.test.js` (helper pur côté SPA) et `capture-webhook.spec.ts` (normalisation Zod côté serveur).
- **Pas de Playwright/E2E** : aucune route nouvelle, aucun parcours utilisateur changé. UAT preview manuel (Task 4) reste hors scope ATDD.

## Generation Mode

**Mode choisi : AI generation, sequential, Vitest only.** Le contrat est entièrement testable au niveau unitaire : un helper pur + un transform Zod déjà couvert par une suite existante. Aucune valeur ajoutée à monter le SFC `WebhookItemsList.vue` pour cette story — l'extraction se prouve sur le helper isolé (le branchement dans le SFC est trivial et couvert par la suite régression `WebhookItemsList.spec.js` à rejouer en step Dev — AC#6).

## Test Strategy — AC → Test Level Mapping

| AC   | Sujet                                                  | Niveau | Fichier                                                                                                | Priorité | Justification choix                                                                                            |
|------|--------------------------------------------------------|--------|--------------------------------------------------------------------------------------------------------|----------|---------------------------------------------------------------------------------------------------------------|
| AC#1 | Extraction `^([0-9]{3,5}(?:-[A-Z0-9]{1,6})?)\s`        | unit   | `extractProductCode.test.js`                                                                           | P0       | Helper pur, zéro IO. Test de regex + fallback slice. Coût render nul.                                          |
| AC#2 | `productName` jamais modifié                           | unit   | `extractProductCode.test.js` (contrat helper) + `capture-webhook.product-code.spec.ts` (parité serveur) | P0       | Sentinel sur le contrat : le helper renvoie une SOUS-chaîne, pas une mutation. Vérifié des deux côtés.         |
| AC#3 | Parité serveur (mirror dans transform Zod)             | unit   | `capture-webhook.product-code.spec.ts`                                                                 | P0       | Anti-drift CR 8.7 : appel direct de `normalizeCaptureItemUnit` + parcours via `captureWebhookSchema.safeParse`. |
| AC#4 | Cas réels (3010-2K, 6162-400GR, fallback, product_id) | unit   | `extractProductCode.test.js` + `capture-webhook.product-code.spec.ts`                                  | P0       | Cas UAT exacts (SAV-2026-00003). Anti-régression "ne pas casser product_id propre".                            |
| AC#5 | Pas de backfill V1                                     | unit   | `capture-webhook.product-code.spec.ts` (sentinel guard)                                                | P2       | Garde-fou de scope : aucune fonction `backfillProductCode`/`rewriteSnapshots` exportée par le module schéma.   |
| AC#6 | Régression capture verte                               | n/a    | suites existantes (`WebhookItemsList.spec.js`, `capture-webhook.spec.ts`, schémas) + `npm run typecheck` | P0       | À rejouer en step Dev — aucun nouveau test à générer (= "ne pas casser le vert").                              |

### Test Levels — Rationale

- **Pas d'E2E/Playwright** : la story est une transformation de string sur un payload sérialisé. Aucun parcours utilisateur, aucun rendu visuel (la colonne Code back-office sera vérifiée en UAT preview manuel via Task 4 — hors scope ATDD).
- **Pas de test d'intégration vraie-DB** : aucune migration, aucun trigger, aucun check constraint touché. Le payload normalisé arrive intact en RPC ; les tests RPC existants restent verts (audit-check-constraints.mjs déjà en place).
- **Pas de test component (Vue Test Utils)** : le branchement dans `WebhookItemsList.vue` (lignes ~821-823) est un simple appel de fonction. Le SFC ne contient aucune logique de présentation propre au code — il passe `productCode` au payload. La suite régression existante prouve que le SFC continue d'émettre un payload valide.

### Priority Rationale

- **P0** (AC#1, AC#2, AC#3, AC#4, AC#6) : la story a été déclenchée par un défaut de données réel UAT 2026-06-10 (PDF avoir colonne Code polluée). Toute régression repollue les snapshots persistés.
- **P2** (AC#5) : sentinel de scope, low-frequency mais utile pour empêcher quelqu'un d'ajouter un backfill non décidé.

## Red Phase Verification

**Exécuté `npx vitest run` sur les deux nouveaux fichiers :**

```
extractProductCode.test.js   → FAIL (Failed to resolve import "../extractProductCode.js")
                                ↳ RED total : le module helper n'existe pas encore.
capture-webhook.product-code.spec.ts → 4 RED (extraction non implémentée) / 7 GREEN (sentinels)
                                ↳ Les 7 GREEN sont anti-régression :
                                  - productCode "PROD-001" inchangé
                                  - productCode "12345" inchangé
                                  - productCode "3010-2K" idempotent
                                  - productCode "POMME GOLDEN VRAC" inchangé
                                  - productName 80+ chars persisté tel quel
                                  - normalizeCaptureItemUnit idempotent sur code propre
                                  - module n'exporte pas backfillProductCode
                                ↳ Les 4 RED prouvent l'extraction attendue :
                                  - 3010-2K (cas UAT SAV-2026-00003)
                                  - 6162-400GR
                                  - 3357-2K
                                  - normalizeCaptureItemUnit ré-extrait directement
```

Contrat TDD red phase respecté : tous les tests qui exercent le **nouveau comportement** échouent avant implémentation. Les tests qui valident des invariants **existants** (priorité product_id, idempotence, immutabilité du label) sont volontairement GREEN — ils protègent contre la régression au moment du GREEN phase.

## Fixture & Mock Strategy

- **Aucun mock externe** : helper pur côté SPA, transform Zod pur côté serveur. Pas de Supabase, pas de fetch, pas d'horloge.
- **Fixtures inline** : payloads minimaux construits par épandage (`...basePayload`, `...baseItem`) — pattern identique à `capture-webhook.spec.ts` existant.
- **Cas réels** : labels copiés textuellement du UAT 2026-06-10 (`3010-2K POMELO STAR RUBY (CN) (CAT II) (CAGETTE DE 2KG)`) pour traçabilité.

## Handoff to Dev

- **À implémenter (Task 1)** : `client/src/features/sav/lib/extractProductCode.js` (helper pur, signature `(label) => string`, regex catalogue + fallback slice).
- **À implémenter (Task 2)** : étendre `normalizeCaptureItemUnit` dans `client/api/_lib/schemas/capture-webhook.ts` pour ré-extraire `productCode` quand il commence par un code catalogue. Heuristique de détection à confirmer en step Dev (voir OPEN QUESTIONS).
- **À implémenter (Task 1, suite)** : brancher l'extraction dans `WebhookItemsList.vue` (lignes ~821-823, ordre de priorité INCHANGÉ : `product_id` > `code` > `extractProductCode(label)` > `slice(0,32)`).
- **À rejouer (Task 3, AC#6)** : `npm test -- WebhookItemsList capture-webhook` + `npm run typecheck`.
