# Story V1.6 — Spec brute (à reprendre par bmad-create-story)

> **Découvert** : UAT V1.5 du 2026-05-06, debug runtime preview Vercel post-V1.5 deploy. Le handler `/api/sav/files/:id/thumbnail` retournait 503 GRAPH_UNAVAILABLE sur les 4 fichiers SAV-2026-00001 (id=18). Debug payload exposé temporairement → **`graphStatus: 400 invalidRequest`** + URL `/v1.0/drives/{driveId}/items/505_25S25_30_6_IMG_4889.JPG/thumbnails/0/medium/content` montrait que `sav_files.onedrive_item_id` contient le **filename** au lieu du vrai item ID Microsoft Graph.
> **Mitigation V1.5** : commit `9d3a2df` bascule l'endpoint Graph sur `/shares/u!{base64url(webUrl)}/driveItem/thumbnails/...` qui résout via `web_url` SharePoint canonique, contournant complètement la valeur foireuse de `onedrive_item_id`.
> **Statut** : bug data résiduel — pré-existant Story 5-7 (capture self-service legacy Make webhook). Pas ship-blocker (V1.5 contourne via webUrl), mais **dette technique** : si webUrl change/expire/devient invalide, le contournement échoue.
> **Format** : spec rapide, à enrichir via `bmad-create-story`.

---

## Problème

`sav_files.onedrive_item_id` est `text NOT NULL` (cf. migration `20260421140000_schema_sav_capture.sql:189`). Le contrat attendu : valeur opaque renvoyée par Microsoft Graph upload session response (ex: `01ABCDEFGHIJKLMNOPQRSTUVWXYZ` ou `b!XXX...` pour drives personnels).

**Réalité observée (SAV-2026-00001 id=18)** : la colonne contient le **filename** sanitisé : `505_25S25_30_6_IMG_4889.JPG`, `505_25S25_30_6_mix-citron-orange-clementine-cn.jpg`, etc.

**Source du bug** : le RPC `capture_sav_from_webhook` (cf. migrations `20260421150000`, `20260422130000`, `20260424130000`, `20260505141000`) lit `v_file ->> 'onedriveItemId'` du JSONB payload envoyé par le webhook. Le legacy Make scenario (3197846 / 3203836) — tué post-V1 cutover Story 5-7 — ne récupérait jamais le vrai item ID Graph (Make n'avait pas accès aux upload sessions Graph) et envoyait probablement le filename comme placeholder.

**Impact** :
- V1.5 fonctionne via le contournement webUrl-based (`/shares/u!.../driveItem`), mais c'est fragile :
  - Si Microsoft change la structure des shareIds (peu probable mais possible)
  - Si webUrl rotation lors d'un changement de tenant ou rename de site
  - Si webUrl est invalidé après anonymisation RGPD Story 7-6 (sav_files.web_url préservé per D-5 mais...)
- Les autres consommateurs futurs de `onedrive_item_id` (download original, share-link create, item delete via Graph) **vont casser** sur ces lignes.
- Audit data integrity faible : on ne peut pas distinguer `onedrive_item_id` valide vs filename via shape (les 2 sont des `text`).

## Hypothèse cause racine (à confirmer Step 1 DS)

À investiguer Step 1 :
1. **Audit volumétrie** : `SELECT count(*) FROM sav_files WHERE onedrive_item_id ~ '\.[a-z]{3,4}$' OR onedrive_item_id NOT SIMILAR TO '01[A-Z0-9]{30,}|b![A-Za-z0-9_-]+'` — combien de lignes affectées ? (uniquement capture flow legacy ou aussi capture self-service Story 5-7 post-cutover ?)
2. **Source actuelle** : grep le pipeline upload courant (`upload-session-handler` + `upload-complete-handler` + frontend WebhookItemsList) pour vérifier que les NOUVEAUX uploads stockent bien le vrai item ID Graph (le response.id du upload session commit) et non le filename.
3. **Frontière temporelle** : trouver date/SAV-ID où le bug s'arrête — si V1 cutover Story 5-7 a corrigé le pipeline upload, alors seuls les SAVs pre-cutover sont affectés (volumétrie cap connue).

## Critères d'acceptation (à ajuster en bmad-create-story)

- **AC #1** — Script `client/scripts/cutover/backfill-sav-files-onedrive-item-id.ts` qui :
  - Liste tous les `sav_files` où `onedrive_item_id` ne matche pas le pattern Graph item ID attendu
  - Pour chaque ligne : query Graph `/shares/u!{base64url(web_url)}/driveItem` → récupère `response.id` (vrai item ID Graph)
  - UPDATE `sav_files SET onedrive_item_id = '<real_graph_id>' WHERE id = ?`
  - Idempotent (re-run safe — skip lignes avec onedrive_item_id déjà valide)
  - Dry-run mode `--dry-run` qui logue mais ne touche PAS la DB
  - Rate-limited (Graph API 429 throttling — exponential backoff)
  - Logue progress + erreurs structurés
- **AC #2** — Tests unit du script (mock Graph + mock Supabase + assertion idempotence)
- **AC #3** — Audit:schema W113 PASS (0 DDL — UPDATE seul sur table existante, allowlist)
- **AC #4** — Backfill effectué sur staging + prod (manuel run avec validation curl post-run)
- **AC #5** — Rollback : pas de rollback nécessaire (UPDATE non-destructif), MAIS conserver une copie CSV des anciens onedrive_item_id avant UPDATE pour audit forensique RGPD si demande
- **AC #6** — Test régression V1.5 : le handler `/api/sav/files/:id/thumbnail` continue de marcher avec les nouvelles valeurs onedrive_item_id (Graph endpoint id-based vs share-based — vérifier les 2 chemins)
- **AC #7** — Doc `docs/runbooks/cutover.md` mise à jour avec section "Backfill onedrive_item_id" et procédure étape par étape
- **AC #8** — Validation post-backfill : V1.5 handler peut REVERT le fallback `web_url` et utiliser uniquement `onedrive_item_id` (cohérent Story 4.5 pattern), OU décision de garder le webUrl-based comme primaire si plus robuste
- **AC #9** — Pipeline upload courant validé : les NOUVEAUX uploads (capture self-service post-V1 + admin upload Story 3.7b) stockent bien le vrai Graph item ID. Si bug persistant côté upload → fix séparé Story V1.6.1 ou backlog.

## Patterns à suivre (à confirmer Step 1 DS)

**Patterns réutilisés** :
- Story 7-7 PATTERN-A — script ops one-shot `client/scripts/cutover/*.ts`
- Story 7-6 — backfill script anonymisation pattern (idempotent + dry-run + log structuré)
- V1.5 PATTERN-V5 — `/shares/u!{base64url(webUrl)}/driveItem` Graph endpoint resolution
- Story 4.5 lazy `require('./graph.js')` pattern
- W113 audit:schema gate

**Pas de pattern NEW posé** — utilisation des conventions existantes.

## Out-of-Scope V1.6

- **OOS #1** — Fix root cause côté pipeline upload si bug persiste sur capture flow courant — Story V1.6.1 séparée
- **OOS #2** — Migration schéma `sav_files` (ALTER COLUMN onedrive_item_id, CHECK constraint regex) — V2 si on veut enforcer le format au niveau DB
- **OOS #3** — Audit complet des autres tables avec OneDrive item IDs (`credit_notes.pdf_onedrive_item_id`, `supplier_exports.onedrive_item_id`) — V1.6.x si nécessaire
- **OOS #4** — Backfill `web_url` si manquant — pré-requis V1.5 fix mais pas dans le scope V1.6 (assume webUrl déjà persisté pour 100% des sav_files)
- **OOS #5** — Métriques Datadog/observability sur `onedrive_item_id` mismatch detection runtime

## Solutions candidates (à arbitrer Step 1 DS)

**Option A — Backfill script one-shot** (recommandé)
- Script TypeScript exécuté manuellement (`npx tsx client/scripts/cutover/backfill-sav-files-onedrive-item-id.ts`)
- Lit DB, query Graph `/shares/u!.../driveItem` pour chaque ligne, UPDATE en batch
- Idempotent + dry-run mode
- Run staging d'abord, prod ensuite après validation
- Estimation S=0.5j

**Option B — Migration RPC PG côté DB**
- Une fonction PG SECURITY DEFINER qui appelle Graph via pg_net extension
- UPDATE au runtime si onedrive_item_id détecté invalide
- Risque : pg_net pas standard Supabase, complexité timeout/error handling
- DEFER V2

**Option C — Fix sur lecture (pas de backfill)**
- Garder le contournement V1.5 webUrl-based comme primaire pour TOUS les fichiers
- Pas de backfill, pas d'UPDATE, dette technique acceptée
- Risque : autres consommateurs futurs (delete file, refresh share-link, etc.) cassent
- DEFER mais à reconsidérer si V1.6 a un coût caché élevé

**Recommandation auteur** : **Option A** — backfill propre, idempotent, dry-run testé staging, run prod en heure creuse. Volumétrie probable < 100 lignes (capture flow legacy uniquement, post-cutover Story 5-7 tout va bien). Estimation 0.5j.

## Bloque

- Adoption pleine de l'item-id-based Graph endpoint (V1.5 actuellement webUrl-based primaire — cohérence Story 4.5 pattern serait id-based primary)
- Évolutions futures : delete file admin, share-link rotation, item rename → tous nécessitent vrai item ID

## Prérequis

- V1.5 done (le handler thumbnail marche déjà via webUrl fallback — V1.6 améliore mais ne débloque rien)
- Audit volumétrie Step 1 (combien de lignes ? Si < 10, manuel SQL UPDATE plus simple que script)

## Estimation

- **S** (small, 0.5j) si volumétrie < 100 lignes + Option A — script + dry-run + run staging + run prod + tests régression V1.5
- **M** (medium, 1j) si volumétrie élevée OU pipeline upload courant aussi buggé (V1.6 + V1.6.1 fix bundle)

## Tests / Validation

- **Test unit du script** : mock Graph + mock Supabase, assert idempotence + dry-run + error handling 429/5xx
- **Test régression V1.5 post-backfill** : `curl /api/sav/files/1/thumbnail` retourne 200 + image/jpeg pour fichiers backfillés (id-based path) ET pour fichiers non-backfillés (webUrl fallback)
- **Smoke test post-prod-run** : grep logs run pour 0 erreurs, 100% succès Graph resolves, count(*) onedrive_item_id valides == count(*) total sav_files

## Risques résiduels post-fix

- **R-1** : Graph `/shares/u!.../driveItem` rate-limit 429 sur batch large → exponential backoff + chunk traitement
- **R-2** : webUrl rotated entre query Graph et UPDATE DB → idempotent re-run mitige (skip si onedrive_item_id déjà valide post-update)
- **R-3** : ancien onedrive_item_id (filename) détruit lors du UPDATE — backup CSV préalable AC #5
- **R-4** : pipeline upload courant aussi buggé → script backfill créera une boucle (NEW upload → bug → backfill → fix) → fix root cause prioritaire si confirmé Step 1
- **R-5** : Graph `Files.Read.All` permission absent → 403 → script échoue gracefully + log + skip ligne (manual remediation)

## Notes diagnostic V1.5 (2026-05-06)

Découvert pendant validation runtime preview Vercel via MCP chrome-devtools + Vercel runtime logs MCP. Debug payload temporaire ajouté commit `75256c5` (puis reverted commit `f05b285`) a exposé `graphStatus: 400 invalidRequest` + le vrai graphUrl utilisé par le handler. Le filename `505_25S25_30_6_IMG_4889.JPG` était substitué directement à `{itemId}` dans la URL Graph.

**SAV-2026-00001 (id=18) confirmé bug** :
- File 1: `onedrive_item_id = '505_25S25_30_6_IMG_4889.JPG'` (filename, pas Graph ID)
- File 2: idem `'505_25S25_30_6_mix-citron-orange-clementine-cn.jpg'`
- File 3: idem `'505_25S25_30_6_mix-pomelo-oranges-citron-cn.jpg'`
- File 4: idem `'505_25S25_30_6_pomelo-jaune-5k-bio.jpg'`

V1.5 mitigation `/shares/u!{base64url(webUrl)}/driveItem/thumbnails` testée OK runtime (commit `9d3a2df`). Les 4 thumbnails s'affichent dans le MCP browser post-deploy.

---

*Spec rédigée 2026-05-06 fin session UAT V1.5. À reprendre via `bmad-create-story` (workflow Steps 1-7) pour produire la story file complète prête à dev. Recommandation : pipeline en mode CHECKPOINT (score complexité prévisible 4-5/14 — code surface 1 fichier script, domain risk data integrity 3/4, decision density 1/3 entre Options A/B/C, external deps 1/2 Graph API, testing 1/2).*
