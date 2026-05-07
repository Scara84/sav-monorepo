# Story 4.8 : Import prix fournisseur per-SAV (calcul marge bout en bout)

Status: done
Epic: 4 — extension capture pricing (post-V1 cutover)
Découvert: 2026-05-06 (audit post-Story 3.7b — pas de visibilité marge / prix d'achat)

## Story

**En tant qu'**opérateur SAV,
**je veux** uploader un fichier Excel/CSV fournisseur (spécifique à la commande SAV en cours, prix négociés au cas par cas) qui pré-remplit les prix d'achat par ligne du SAV,
**afin que** je puisse voir la marge SAV par ligne (PU client - PU fournisseur) et au total, et émettre une demande fournisseur cohérente avec ce que j'ai facturé au client.

## Problème root cause (audit 2026-05-06)

1. La table `sav_lines` ne stocke que `unit_price_ht_cents` (prix vente client) — aucune colonne prix d'achat fournisseur
2. Aucune UI ne montre le coût d'achat ni la marge par ligne
3. **Précision PM (2026-05-06)** : il N'Y A PAS d'import catalogue global parce que pour chaque commande client, il peut y avoir des prix négociés spécifiques. Le bon design est un import per-SAV, pas un sync produits.
4. L'opérateur travaille aujourd'hui à l'aveugle côté rentabilité quand il valide un SAV

## Scope V1

- **AC #1** — Migration `sav_lines` : ajouter colonnes
  - `supplier_purchase_price_ht_cents bigint NULL` (cents EUR HT)
  - `supplier_reference text NULL` (référence produit fournisseur, peut différer du `product_code` Rufino interne)
  - `supplier_price_imported_at timestamptz NULL` (audit + idempotence)
  - `supplier_price_source text NULL` (filename uploadé, traçabilité forensic)
- **AC #2** — Endpoint `POST /api/sav/:id/import-supplier-prices` (op-router `api/sav.ts`, slot Vercel 12/12 préservé) :
  - Body multipart/form-data : fichier CSV ou XLSX, max 5 MB, MIME whitelist
  - Parser robuste (utiliser `xlsx` ou `papaparse` selon préférence — vérifier ce qui existe déjà dans `package.json`)
  - Format attendu (V1 figé) : colonnes `code`, `quantity`, `unit_price_ht`, `supplier_ref` (optionnelle). Header obligatoire ligne 1.
  - Matching : `code` ↔ `sav_lines.product_code` (exact match d'abord, fuzzy déféré V2). Lignes sans match → renvoyées dans la réponse pour validation manuelle.
  - Réponse JSON : `{ matched: [{lineId, code, oldPriceCents, newPriceCents}], unmatched: [{code, supplierRef, unitPriceHt, qty}], errors: [...] }`
  - **Pas d'UPDATE direct** — la réponse alimente une preview UI, l'UPDATE attend confirmation explicite (AC #3)
- **AC #3** — Endpoint `PATCH /api/sav/:id/apply-supplier-prices` : prend un mapping ligne SAV ↔ prix d'achat (post-validation UI) et UPDATE en transaction. RBAC operator standard groupe + admin bypass (pattern Story 7-3a/b/c). RLS scope-groupe.
- **AC #4** — UI back-office `SavDetailView.vue` : nouveau bouton "Importer prix fournisseur" dans la barre d'actions header. Click → modal :
  1. Upload zone (drag&drop + button)
  2. Preview tableau matched/unmatched (chaque ligne unmatched = combo manuel "rattacher à ligne SAV X" ou "ignorer")
  3. Bouton "Appliquer" → PATCH endpoint → toast succès → close modal → refetch SAV
- **AC #5** — Affichage marge dans le tableau lignes (UI back-office) :
  - Nouvelle colonne "PU achat HT (€)" affichant `supplier_purchase_price_ht_cents` formaté ou "—"
  - Nouvelle colonne "Marge unit. (€)" = `unit_price_ht_cents - supplier_purchase_price_ht_cents` (positif vert, négatif rouge, NULL gris)
  - Footer tableau : "Marge totale SAV : X €" agrégé sur les lignes ayant les 2 prix renseignés
- **AC #6** — Tests handler import (`tests/unit/api/sav/import-supplier-prices.spec.ts`) : 6 scénarios
  - (a) CSV valide 3 lignes match exact
  - (b) XLSX valide 5 lignes dont 2 unmatched
  - (c) Format invalide (colonnes manquantes) → 400 INVALID_FORMAT
  - (d) Fichier > 5 MB → 413
  - (e) MIME pas whitelist → 415
  - (f) Idempotence : re-upload même fichier → écrase prix existants, met à jour `supplier_price_imported_at`
- **AC #7** — Tests UI (`SavDetailView.import-supplier.spec.ts` + `SavLinesTable.margin.spec.ts`) : 4 scénarios bouton import + modal preview + 3 scénarios affichage marge (positif/négatif/null)
- **AC #8** — Test E2E preview : opérateur ouvre `/admin/sav/:id` (avec prix client captures via Story 4.7), upload un fichier fournisseur de test, valide, voit la marge calculée et cohérente.

## Out-of-Scope V1

- **OOS-1** — Auto-matching fuzzy / fuzzy-search par nom produit (V2 si match rate < 80% en prod)
- **OOS-2** — Format Pennylane direct (l'opérateur reformat un Excel intermédiaire pour V1)
- **OOS-3** — Historique imports (1 import écrase l'autre pour V1, audit dans `audit_trail` Story 7.5 si déjà câblé)
- **OOS-4** — Calcul marge au niveau total SAV avec TVA et coefficient avoir (V2, scope Story 4.X dédiée — V1 = marge HT brute)
- **OOS-5** — Alertes marge négative au moment du Validate (déféré V2 — opérationnel après mesure terrain)
- **OOS-6** — Multi-fournisseurs sur un même SAV (V1 = 1 fichier = 1 fournisseur ; structure `supplier_reference` permet l'extension)
- **OOS-7** — Export marge dans le bon SAV PDF (Story 4.5) — déféré V2

## Dépendances

- **Bloque par** : Story 4.7 (capture prix client) — sans prix vente captures, la marge calculée est inutile (toujours `null - x = null`).
- **Bloque** : feature complète "traiter un SAV de bout en bout avec visibilité rentabilité" — sans elle, l'opérateur valide à l'aveugle.

## Risques

- **R-1** — Format fichier fournisseur hétérogène (chaque fournisseur peut envoyer un CSV/XLSX différent) → V1 fixe un format canonique imposé à l'opérateur (qui reformat manuellement si nécessaire). Pas idéal mais réaliste V1.
- **R-2** — Volumétrie : 200 lignes max par SAV (cap webhook capture-webhook.ts:42) → parsing rapide, pas de risque perf.
- **R-3** — Sécurité fichier uploadé : MIME spoofing CSV/XLSX, formula injection (`=cmd|...`) côté Excel. Mitigation : sanitize cellules text au parse (pattern Story 5.4 P1 CSV-injection déjà en place).
- **R-4** — RLS leak : opérateur d'un autre groupe upload pour un SAV qui ne lui appartient pas → 403 via withAuth + group scope (pattern Story 7-3a/b/c).
- **R-5** — Trigger freeze `unit_price_ht_cents_freeze_after_insert` ne s'applique PAS à `supplier_purchase_price_ht_cents` (nouvelle colonne, pas dans le freeze) → opérateur peut re-uploader plusieurs fois. OK comportement V1.

## Estimation

M = 2j code (migration + 2 endpoints + parser + UI modal + 2 tableaux affichage marge + tests) + 0.5j UAT preview avec fichier fournisseur réel = **~2.5j calendaire**.

## Patterns posés / réutilisés

- **PATTERN-NEW (à poser)** : import per-entity de pricing depuis fichier opérateur (parse → preview → confirm → UPDATE transactionnel). Réutilisable pour futurs imports per-SAV (ex: prix négociés transport, frais accessoires).
- Réutilise : Story 7-3a/b/c RBAC + group scope, Story 5.4 P1 CSV-injection sanitization, Story 3.7b PATTERN-D upload-session (binding sav→file pour audit), Story 3.6b inline edit pattern (UPDATE transaction sav_lines).

## Source

Spec brute créée 2026-05-06 par Antho post-pipeline Story 3.7b. Précision PM 2026-05-06 : pas d'import catalogue global (chaque commande peut avoir prix négocié spécifique) → design per-SAV file import. Découpage avec Story 4.7 (capture prix client) cohérent : 4.7 pose le côté vente, 4.8 pose le côté achat, ensemble = bout en bout marge visible.
