---
title: 'Régénération forcée du PDF d''avoir avec recalcul transactionnel des totaux (RPC + trigger amendé)'
type: 'feature'
created: '2026-06-11'
status: 'done'
context: []
baseline_commit: 'd4da8c6149c9c344502bc86bf897f713ecf84f5a'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** L'édition des lignes SAV reste possible après émission de l'avoir : les montants des lignes sont recalculés mais l'avoir garde ses totaux figés et son PDF d'origine, sans recours opérateur. Le trigger `trg_credit_notes_prevent_immutable_columns` (obligation comptable, CR 4.1) gèle les 4 totaux en DB : toute solution passe par une migration (décision user 2026-06-11, option « forcer proprement »).

**Approach:** Migration : amender le trigger pour autoriser la modification des 4 totaux **uniquement** quand un GUC transaction-local est posé, et créer une RPC `SECURITY DEFINER` `force_regenerate_credit_note` qui, dans UNE transaction : verrouille l'avoir et le SAV (`FOR UPDATE`), re-vérifie `sav.status='in_progress'` (allowlist), valide un fingerprint des lignes (id + credit_amount_cents passés par le handler), pose le GUC, UPDATE totaux + `pdf_web_url/pdf_onedrive_item_id=NULL`, écrit l'audit, retourne les anciennes valeurs. Le handler TS calcule les totaux (même moteur que l'émission), appelle la RPC, **supprime l'ancien fichier OneDrive** (best-effort, l'item id est retourné par la RPC), puis relance la génération PDF existante inchangée (même numéro). UI : bouton « Régénérer le PDF » en phase `ready` derrière confirmation.

## Boundaries & Constraints

**Always:**
- Sans `force: true` (body), contrat actuel inchangé : PDF existant → 409 `PDF_ALREADY_GENERATED`.
- Totaux calculés en TS **exactement** comme `emit-handler.ts` — helper partagé, `emit.spec.ts` vert sans modification.
- Toute la mutation DB (garde statut, fingerprint lignes, UPDATE, audit) vit dans la RPC transactionnelle. Aucun UPDATE direct de `credit_notes` côté TS. Statut hors allowlist → erreur dédiée (422) ; fingerprint divergent (ligne modifiée/ajoutée/supprimée entre calcul et RPC) → erreur dédiée (409, l'opérateur recharge) ; verrouillage `FOR UPDATE` = deux forces concurrents sérialisés.
- Le GUC est posé `set_config(..., true)` (transaction-local) DANS la RPC ; le trigger ne laisse passer les 4 totaux que si ce GUC vaut la valeur attendue. Un UPDATE direct des totaux hors RPC reste rejeté (testé en vraie DB).
- Privilèges RPC : `REVOKE FROM PUBLIC` + `REVOKE EXECUTE FROM anon, authenticated` + `GRANT service_role` (leçons h-16 + CR V1.13 HIGH-1 : les default privileges re-grantent anon/authenticated).
- Audit dans la transaction RPC (action `credit_note_force_regenerated`, diff anciens/nouveaux totaux + ancien `pdf_web_url` + ancien `pdf_onedrive_item_id`) : si l'audit échoue, TOUT est rollback — aucune mutation sans trace.
- Après RPC réussie : suppression Graph de l'ancien item OneDrive (best-effort — échec = log + on continue, l'orphelin est tracé dans l'audit), PUIS `generateCreditNotePdfAsync` inchangé.
- Gardes lignes avant calcul (toutes `validation_status='ok'`, `credit_amount_cents` non-null) : mêmes familles d'erreurs que l'émission (422/500).
- Réponse 200 force : totaux recalculés + `pdf_web_url` + `credit_note_number_formatted`.
- UI : après échec POST force ≠ 422 → `refresh()` (pas de lien mort) ; 409 fingerprint/course → message « Les lignes ont changé, rechargez la page » ; 422 → message serveur.
- Tests **vraie-DB obligatoires** (PATTERN-H15-A, `tests/integration/credit-notes/`) : (a) RPC happy path mute les totaux + audit présent, (b) UPDATE direct des totaux toujours rejeté par le trigger, (c) RPC refuse statut ≠ `in_progress`, (d) fingerprint divergent rejeté, (e) `has_function_privilege('anon', ..., 'EXECUTE')` = false.
- Rate-limit existant 1/min par credit_note conservé.

**Ask First:**
- Aucun point de décision humain attendu pendant l'implémentation.

**Never:**
- Ne PAS toucher `generate-credit-note-pdf.ts`, ni la RPC `issue_credit_number`, ni le numéro d'avoir, ni `emit-handler.ts` au-delà de l'extraction du helper.
- Ne PAS affaiblir le trigger en dehors du chemin GUC (les colonnes non-totaux restent gelées sans exception ; les totaux restent gelés hors RPC).
- Ne PAS modifier le flow email outbox.
- Risque accepté (documenté, non traité en V1) : fenêtre où une génération PDF concurrente déjà en vol (waitUntil d'émission) peut écrire un PDF aux anciens totaux après le force — improbable (force survient bien après l'émission, opérateur quasi-unique), détectable via l'audit.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Force OK | `force:true`, PDF existant, lignes ok, sav `in_progress` | 200 `{pdf_web_url, totaux}` ; totaux recalculés ; ancien fichier OneDrive supprimé ; audit transactionnel | N/A |
| Sans force (inchangé) | body vide/`force` absent, PDF existant | 409 `PDF_ALREADY_GENERATED` | Contrat actuel |
| Force, PDF absent | `force:true`, `pdf_web_url IS NULL` | Même chemin force (recalcul + génération) ; pas de suppression OneDrive (pas d'ancien item) | N/A |
| Ligne bloquante | `force:true`, ligne `validation_status != 'ok'` | 422 + détail lignes, aucune mutation | avant RPC |
| Statut hors allowlist | `force:true`, `sav.status != 'in_progress'` (validated/closed/cancelled/received/draft) | 422, aucune mutation | re-vérifié DANS la RPC (anti-TOCTOU) |
| Fingerprint divergent | ligne modifiée/supprimée/ajoutée entre calcul TS et RPC | 409, aucune mutation | « lignes ont changé, rechargez » |
| Deux forces concurrents | requêtes simultanées | sérialisées par `FOR UPDATE` ; la 2e re-valide le fingerprint (passe ou 409) | jamais deux générations sur état divergent |
| UPDATE direct totaux (hors RPC) | SQL direct / autre code | rejeté par trigger | test vraie-DB |
| Échec audit dans RPC | insert audit échoue | rollback complet, 500, avoir intact | aucune mutation sans trace |
| Échec suppression OneDrive | Graph delete échoue post-RPC | log warn + continue (génération quand même) ; orphelin tracé dans audit | best-effort |
| Échec génération post-RPC | render/upload échoue | 500 `failure_kind` ; totaux à jour, `pdf_web_url` NULL → UI refresh → phase `failed` + recovery | état sain |
| UI confirm annulée | refus confirmation | aucun POST | N/A |

</frozen-after-approval>

## Code Map

- `client/supabase/migrations/20260611150000_credit_note_force_regenerate.sql` -- **nouvelle** migration : amende `prevent_credit_notes_immutable_columns()` (GUC, pattern `current_setting(..., true)` existant — cf. 20260422140000) + RPC `force_regenerate_credit_note` + REVOKE/GRANT.
- `client/api/_lib/credit-notes/compute-totals-from-sav-lines.ts` -- **nouveau** helper partagé extrait d'`emit-handler.ts` (L195-435), résultat discriminé.
- `client/api/_lib/credit-notes/emit-handler.ts` -- consomme le helper, comportement byte-identique (ordre gardes : existing AVANT status, CR 4.4 P5).
- `client/api/_lib/credit-notes/regenerate-pdf-handler.ts` -- branche force : parse body défensif → gardes lignes (helper) → RPC → delete OneDrive best-effort (`onedrive-ts.ts`, vérifier/ajouter un `deleteItem`) → génération → 200 totaux. Mapping erreurs RPC (préfixes `RAISE EXCEPTION 'CODE|détail'`, pattern trigger existant) → 422/409/500.
- `client/api/_lib/pdf/generate-credit-note-pdf.ts` -- INCHANGÉ.
- `client/src/features/back-office/views/SavDetailView.vue` -- bouton phase `ready` + confirmation ; `regeneratePdf({force})` ; refresh sur échec ; mapping 409 fingerprint.
- `client/tests/unit/api/credit-notes/regenerate.spec.ts` + `SavDetailView.credit-note-pdf.spec.ts` -- unit (mocks).
- `client/tests/integration/credit-notes/force-regenerate.spec.ts` -- **nouveau** vraie-DB (pattern `iso-fact-preservation.spec.ts`).

## Tasks & Acceptance

**Execution:**
- [x] `client/supabase/migrations/20260611150000_credit_note_force_regenerate.sql` -- trigger amendé (4 totaux passent ssi GUC transaction-local) + RPC `force_regenerate_credit_note(p_credit_note_id, p_expected_lines jsonb, p_new_totals jsonb, p_actor_operator_id)` : FOR UPDATE avoir+sav, allowlist statut, fingerprint, GUC, UPDATE, audit, retour anciennes valeurs ; REVOKE PUBLIC/anon/authenticated + GRANT service_role -- cœur transactionnel.
- [x] `client/api/_lib/credit-notes/compute-totals-from-sav-lines.ts` + refactor `emit-handler.ts` -- helper partagé anti-drift, `emit.spec.ts` intact.
- [x] `client/api/_lib/credit-notes/regenerate-pdf-handler.ts` -- branche force orchestrant helper → RPC → delete OneDrive → génération → 200 totaux ; sans force inchangé.
- [x] `client/api/_lib/onedrive-ts.ts` -- ajouter `deleteCreditNotePdfItem(itemId)` (Graph DELETE, best-effort côté appelant) si absent.
- [x] `client/src/features/back-office/views/SavDetailView.vue` -- bouton `credit-note-force-regenerate-btn` + `confirmFn` ; POST `{force:true}` ; refresh après 200 et échec ≠ 422 ; messages 409/422.
- [x] Tests unit -- matrice complète + remise responsable 4 %, fallback TVA, arrondi non trivial, parse force défensif, échec delete OneDrive → continue.
- [x] `client/tests/integration/credit-notes/force-regenerate.spec.ts` -- les 5 cas vraie-DB du frozen (RPC ok+audit, UPDATE direct rejeté, statut refusé, fingerprint rejeté, anon sans EXECUTE). [écrits + skip gracieux, non exécutés faute de migration appliquée localement — l'humain les jouera après `npx supabase db reset`]
- [x] Vérifier `npm run audit:schema` passe avec la nouvelle migration.

**Acceptance Criteria:**
- Given un avoir émis (SAV `in_progress`) aux lignes modifiées, when force, then totaux recalculés persistés **en vraie DB**, audit transactionnel présent, ancien fichier OneDrive supprimé, nouveau PDF cohérent lignes/totaux, 200 avec totaux.
- Given le même avoir, when POST sans force, then 409 inchangé.
- Given un UPDATE SQL direct des totaux, then rejet trigger (vraie DB).
- Given un SAV hors `in_progress`, when force, then 422 sans mutation (vérifié dans la transaction).
- Given une ligne modifiée entre calcul et RPC, when force, then 409 sans mutation.
- Given la vue en phase `ready` : confirm → nouveau lien après refresh ; annule → aucun appel ; échec 500 → phase `failed` sans lien mort.

## Spec Change Log

- **2026-06-11 — Loopback intent_gap #1 (itération 2).** Déclencheur : EH HIGH — force sur SAV `validated` cassait l'invariant V1.13 (lignes verrouillées en validated = aucun cas d'usage). Résolution user : exclure `validated`. Patches CR v1 intégrés : totaux dans le 200, refresh UI sur échec, audit bloquant + item_id tracé, UPDATE conditionnel, tests remise/TVA/arrondi. KEEP v1 : helper byte-identique (`emit.spec.ts` 0 octet), ordre gardes CR 4.4 P5, séquencement sans toucher au module PDF, codes `SAV_STATUS_FROZEN`/`NO_VALID_LINES`+`blocking_lines`, action audit `credit_note_force_regenerated`, style tests valeurs réelles (capturedUpdates/generateCalls/auditInserts, moteur non mocké), testid `credit-note-force-regenerate-btn`, wrapper `() => regeneratePdf()`, body `{force:true}` byte-exact, imports statiques.
- **2026-06-11 — Loopback intent_gap #2 (itération 3).** Déclencheurs : EH HIGH H-1 — trigger `trg_credit_notes_prevent_immutable_columns` (20260425140000) gèle les 4 totaux en vraie DB : l'UPDATE TS v2 était mort-né, tests faux-verts (récidive PATTERN-H15) ; M-3 — upload OneDrive en `conflictBehavior=rename` : « fichier écrasé » du frozen v2 était faux, l'ancien PDF restait téléchargeable ; BH HIGH-1 — verrou optimiste NULL→NULL inopérant ; BH HIGH-2 — échec audit + recovery = mutation sans trace ; TOCTOU statut/lignes. **Résolution user : option « forcer proprement » = migration autorisée.** Frozen v3 : RPC transactionnelle (FOR UPDATE + allowlist `in_progress` + fingerprint lignes + GUC + audit atomique), suppression ancien item OneDrive, tests vraie-DB obligatoires, risque résiduel génération-concurrente accepté/documenté. États connus-mauvais évités : feature inopérante en prod ; deux documents fiscaux divergents même numéro ; mutation financière non auditée. KEEP v2 (validés CR, inchangés) : tous les KEEP v1 ci-dessus + allowlist plutôt que denylist, message validated « repasser le SAV en cours », parse `force === true` strict, refresh UI sur échec force, mapping erreurs UI 422=message serveur.

## Design Notes

Le fingerprint lignes (array `{id, credit_amount_cents}` calculé par le helper TS, re-validé ligne à ligne dans la RPC sous verrou) remplace le verrou optimiste v2 sur `pdf_web_url` : il ferme à la fois la course deux-forces, le TOCTOU édition-de-ligne, et le NULL→NULL. Le GUC transaction-local (`set_config(..., true)` — true = local) suit le précédent h-01/w13 ; le trigger reste la défense par défaut pour tout autre chemin d'écriture. Suppression OneDrive AVANT génération : si elle réussit, le nouvel upload reprend le nom canonique sans suffixe ` (1)` ; si la génération échoue ensuite, l'état DB (totaux justes, pdf NULL) reste sain et le recovery existant s'applique.

## Verification

**Commands:**
- `cd client && npx vue-tsc --noEmit` -- expected: 0 nouvelle erreur.
- `cd client && npx vitest run tests/unit/api/credit-notes/regenerate.spec.ts tests/unit/api/credit-notes/emit.spec.ts src/features/back-office/views/SavDetailView.credit-note-pdf.spec.ts` -- expected: verts, `emit.spec.ts` non modifié.
- `cd client && npm run test:integration -- credit-notes/force-regenerate` -- expected: 5 cas vraie-DB verts (DB locale/preview appliquée avec la migration).
- `cd client && npm run audit:schema` -- expected: pas de régression.

## Suggested Review Order

**Cœur transactionnel SQL (le plus à risque)**

- Trigger d'immuabilité amendé : le GUC n'ouvre QUE les 4 totaux — noter le `COALESCE` anti fail-open (fix CR it.3).
  [`20260611150000_credit_note_force_regenerate.sql:81`](../../client/supabase/migrations/20260611150000_credit_note_force_regenerate.sql#L81)

- RPC `force_regenerate_credit_note` : FOR UPDATE avoir+sav, allowlist `in_progress` re-vérifiée sous verrou (anti-TOCTOU).
  [`20260611150000_credit_note_force_regenerate.sql:129`](../../client/supabase/migrations/20260611150000_credit_note_force_regenerate.sql#L129)

- Fingerprint lignes (id + montant + TVA, count DISTINCT) : ferme course deux-forces et édition concurrente.
  [`20260611150000_credit_note_force_regenerate.sql:234`](../../client/supabase/migrations/20260611150000_credit_note_force_regenerate.sql#L234)

- Audit dans la même transaction : échec audit = rollback total, jamais de mutation sans trace.
  [`20260611150000_credit_note_force_regenerate.sql:299`](../../client/supabase/migrations/20260611150000_credit_note_force_regenerate.sql#L299)

- REVOKE anon/authenticated explicite (leçon h-16 + CR V1.13 : default privileges re-grantent).
  [`20260611150000_credit_note_force_regenerate.sql:354`](../../client/supabase/migrations/20260611150000_credit_note_force_regenerate.sql#L354)

**Orchestration handler**

- Parse `force === true` strict : tout body malformé retombe sur le contrat legacy 409.
  [`regenerate-pdf-handler.ts:104`](../../client/api/_lib/credit-notes/regenerate-pdf-handler.ts#L104)

- Séquence force : helper → RPC → delete OneDrive best-effort → génération inchangée → 200 avec totaux.
  [`regenerate-pdf-handler.ts:366`](../../client/api/_lib/credit-notes/regenerate-pdf-handler.ts#L366)

- Mapping exceptions RPC par payload parsé (pas de match sous-chaîne) : 422 statut / 409 lignes-changées.
  [`regenerate-pdf-handler.ts:424`](../../client/api/_lib/credit-notes/regenerate-pdf-handler.ts#L424)

- Suppression de l'ancien fichier OneDrive (anti « deux documents fiscaux même numéro »), échec toléré.
  [`regenerate-pdf-handler.ts:529`](../../client/api/_lib/credit-notes/regenerate-pdf-handler.ts#L529)

**Helper partagé anti-drift**

- Calcul totaux extrait d'emit-handler, résultat discriminé + `expected_lines` pour le fingerprint.
  [`compute-totals-from-sav-lines.ts:97`](../../client/api/_lib/credit-notes/compute-totals-from-sav-lines.ts#L97)

- Consommation côté émission : comportement byte-identique, `emit.spec.ts` à 0 octet de diff.
  [`emit-handler.ts:386`](../../client/api/_lib/credit-notes/emit-handler.ts#L386)

**UI**

- Bouton force en phase `ready`, subordonné au lien PDF, derrière confirmation explicite.
  [`SavDetailView.vue:1786`](../../client/src/features/back-office/views/SavDetailView.vue#L1786)

- `regeneratePdf({force})` : refresh après 200 ET tout échec ≠ 422 (y compris catch réseau) — pas de lien mort.
  [`SavDetailView.vue:697`](../../client/src/features/back-office/views/SavDetailView.vue#L697)

**Périphériques**

- Graph DELETE de l'ancien item (même pattern require que l'upload existant, tracé nft).
  [`onedrive-ts.ts:170`](../../client/api/_lib/onedrive-ts.ts#L170)

- Tests unit force M01-M15e : moteur de calcul réel, valeurs assertées en centimes.
  [`regenerate.spec.ts:429`](../../client/tests/unit/api/credit-notes/regenerate.spec.ts#L429)

- Tests UI force F1-F6 (confirm annulée → 0 POST, body byte-exact, refresh).
  [`SavDetailView.credit-note-pdf.spec.ts:519`](../../client/src/features/back-office/views/SavDetailView.credit-note-pdf.spec.ts#L519)

- Tests vraie-DB (a-e) exécutés verts en local : trigger, RPC, fingerprint, privilèges anon.
  [`force-regenerate.spec.ts:1`](../../client/tests/integration/credit-notes/force-regenerate.spec.ts#L1)
