# Story 4.7 : Capture des prix client depuis facture (extension webhook)

Status: backlog
Epic: 4 — extension capture pricing (post-V1 ship-blocker)
Découvert: 2026-05-06 (audit post-Story 3.7b — UI back-office showing NULL prices)

## Story

**En tant qu'**opérateur SAV,
**je veux** que les prix de la facture client (PU HT, taux TVA, qté facturée, ID ligne facture source) soient automatiquement capturés au moment où le membre crée sa demande SAV via le self-service,
**afin que** je puisse calculer le remboursement client sur les vrais prix facturés sans avoir à re-saisir manuellement chaque ligne ni à aller chercher la facture Pennylane d'origine.

## Problème root cause (audit 2026-05-06)

1. Le membre voit ses lignes facturées AVEC les prix dans `InvoiceDetails.vue` (lookup `/api/invoices/lookup` → Pennylane)
2. Au submit du form self-service, Make.com envoie un webhook vers `/api/webhooks/capture` avec un payload qui ne contient QUE `productCode`, `productName`, `qtyRequested`, `unit`, `cause` (schema `capture-webhook.ts:31-39`)
3. La RPC Postgres `capture_sav_from_webhook` (migration `20260505141000`) INSERT dans `sav_lines` avec `unit_price_ht_cents = NULL`, `vat_rate_bp_snapshot = NULL`, `qty_invoiced = NULL`
4. L'opérateur ouvre `/admin/sav/:id` → l'UI affiche "PU HT : —" partout (rendering correct, données vides)
5. **Le trigger `unit_price_ht_cents_freeze_after_insert` (migration `20260426130000`) bloque toute UPDATE post-INSERT sur la colonne** → l'opérateur ne peut PAS simplement éditer la ligne pour saisir le prix manquant ; il doit créer une nouvelle ligne (UX cassée)

## Scope V1

- **AC #1** — Étendre `captureWebhookSchema` (Zod) côté Vercel : ajouter dans `items[]` les champs optionnels `unitPriceHtCents: z.number().int().nonnegative().optional()`, `vatRateBp: z.number().int().nonnegative().max(10000).optional()`, `qtyInvoiced: z.number().nonnegative().optional()`, `invoiceLineId: z.string().max(128).optional()`. Optionnels pour rétrocompat (un payload Make.com qui ne les envoie pas reste accepté avec NULL en base, comportement actuel).
- **AC #2** — Étendre RPC `capture_sav_from_webhook` (nouvelle migration) : lire `v_item ->> 'unitPriceHtCents'`, `'vatRateBp'`, `'qtyInvoiced'`, `'invoiceLineId'` depuis le JSONB et les INSERT dans `sav_lines`. Si absents → NULL (comportement legacy préservé). **Vérifier interaction avec le trigger freeze** : le freeze ne s'applique qu'aux UPDATE post-INSERT, donc INSERT avec valeur non-null doit passer.
- **AC #3** — Ajouter colonne optionnelle `sav_lines.invoice_line_id text NULL` (traçabilité ligne facture → ligne SAV pour reconciliation future export Rufino + audit).
- **AC #4** — Update Make.com flow (action OPS, pas code) : avant POST webhook, faire un lookup Pennylane invoice et merger `unitPriceHtCents` (cents entiers ⚠ pas euros) + `vatRateBp` + `qtyInvoiced` + `invoiceLineId` dans chaque item du payload. **Documenter le mapping Pennylane→webhook dans `docs/integrations/make-capture-flow.md`** (créer si absent).
- **AC #5** — Tests : 3 scénarios capture
  - (a) payload avec prix complets → INSERT sav_lines avec PU HT, taux TVA, qty facturée, invoice_line_id, validation_status passe ok
  - (b) payload sans prix (legacy/dégradé) → INSERT avec NULL, validation_status reste 'ok' (graceful), warning loggé
  - (c) payload prix=0 → INSERT 0 cents (distinct de NULL — gratuité ou geste commercial)
- **AC #6** — Test E2E (Playwright ou MCP chrome-devtools sur preview) : member crée SAV via self-service real-feel → opérateur ouvre `/admin/sav/:id` → voit les vrais prix dans le tableau lignes → preview avoir Story 4.3 calcule un total cohérent avec la facture d'origine.

## Out-of-Scope V1

- **OOS-1** — Backfill des SAV déjà créés sans prix (V1.1 séparée si nécessaire) : script qui re-fetche Pennylane par `invoice.ref` et met à jour les lignes existantes. ⚠ bloqué par le trigger freeze → requiert soit lever le trigger temporairement, soit re-créer les lignes.
- **OOS-2** — Validation cohérence prix webhook vs Pennylane authoritative (anti-tampering Make.com) : déféré V2 si on découvre des écarts en prod.
- **OOS-3** — Capture prix d'achat fournisseur côté webhook (c'est le scope Story 4.8 per-SAV file import, pas Pennylane).
- **OOS-4** — Multi-currency (V1 = EUR uniquement, hardcoded).

## Dépendances

- **Bloque** : tout SAV en prod traitable end-to-end (sans elle, l'opérateur retape tout). Ship-blocker post-cutover.
- **Bloque** : Story 4.8 (import fournisseur per-SAV) — sans prix vente captures côté client, le calcul de marge n'a pas de référence.
- **Dépend de** : Make.com flow update (action OPS) — peut être préparée côté code et activée le jour où Make.com pousse les nouveaux champs.

## Risques

- **R-1** — Make.com flow update non synchronisé avec le déploiement Vercel : payload côté code accepte les nouveaux champs (optionnels) AVANT que Make les envoie → comportement legacy NULL préservé jusqu'à activation côté Make. Pas de risque de régression.
- **R-2** — Trigger freeze `unit_price_ht_cents_freeze_after_insert` interfère si le payload Make envoie le prix mais avec une race vs. opérateur qui édite manuellement. Mitigation : ne pas activer côté Make tant que l'opérateur teste manuellement en preview.
- **R-3** — Pennylane lookup côté Make ajoute latence au submit (lookup synchrone). Acceptable V1 (capture asynchrone background, pas de feedback UX direct au membre). Mesurer en preview.
- **R-4** — `vatRateBp` mal interprété (basis points vs pourcentage) : 5.5% TVA = `550` bp, PAS `5.5` ni `0.055`. Test fixture explicite à blinder.

## Estimation

S = 0.5j code (schema Zod + migration RPC + 1 colonne `invoice_line_id` + tests) + ~1j coordination OPS Make.com flow + UAT preview avec un vrai membre/facture. **Total ~1.5j calendaire**.

## Pattern réutilisé / posé

- Réutilise PATTERN existant : capture_sav_from_webhook RPC migration pattern (Story 2.2 + 4.0 + 5.0 cumulés)
- Aucun pattern NEW à poser

## Source

Spec brute créée 2026-05-06 par Antho post-pipeline Story 3.7b. Audit Explore agent confirme : capture flow Story 2.2/2.4 a été livré avec un schema webhook amputé des prix (oversight Epic 2 / 5.7). UI Story 3.6b/3.7b affiche fidèlement le NULL → fail en preview révèle le trou.
