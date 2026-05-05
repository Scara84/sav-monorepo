# Story V1.5 — Spec brute (à reprendre par bmad-create-story)

> **Découvert** : UAT V1.3 du 2026-05-05 sur preview Vercel. Après fix V1.3 ESM cold-start, `/admin/sav/18` charge proprement et affiche les 4 fichiers SAV — mais les **thumbnails images ne s'affichent pas** dans n'importe quel navigateur sans session Microsoft active.
> **Statut** : bug UX back-office, pré-existant (pas introduit par V1.3). Bloque l'usage opérateur quotidien — un opérateur sur un poste partagé ou non-Microsoft doit ouvrir chaque fichier individuellement (clic "Ouvrir") au lieu de scanner les aperçus.
> **Priorité** : haute pour V1.5 patch (bloque adoption back-office), pas ship-blocker V1.0.0 (l'app fonctionne).
> **Format** : spec rapide, à enrichir via `bmad-create-story` (workflow standard BMad).

---

## Problème

**Symptôme** : sur `/admin/sav/:id`, la section "Fichiers" affiche les vignettes images via `<img src="<webUrl SharePoint>">` directement. Sur tout browser sans session Microsoft fraîche, Chrome bloque la requête avec `net::ERR_BLOCKED_BY_ORB` (Opaque Resource Blocking) :

```
GET https://fstock-my.sharepoint.com/personal/.../IMG_4889.JPG
→ net::ERR_BLOCKED_BY_ORB
```

**Cause technique** :
- Les `webUrls` SharePoint pointent vers une page HTML de login si non-authentifié, pas un fichier image direct
- Chrome ORB refuse de charger ces réponses comme `<img>` car le `Content-Type` est `text/html` (page login) au lieu de `image/*`
- Cross-origin sans header CORS approprié + pas de `nosniff`

**Pourquoi ça marche parfois en UAT** : si l'opérateur a une session SharePoint ouverte dans un autre onglet, le browser suit la redirect login silencieusement et SharePoint renvoie l'image. Dépendance fragile : poste partagé / browser fraîche / cookies expirés → bug.

**Impact opérateur quotidien** :
- Tri visuel des SAV impossible sans cliquer chaque fichier
- Sur incidents avec 10+ photos, productivité divisée par 10
- Ships V1 utilisable mais opérateurs perdent confiance

## Hypothèse cause racine (à confirmer Step 1 DS)

Les fichiers uploadés via `/api/upload-session` (Story 2.4 OneDrive) stockent **uniquement la `webUrl` SharePoint** dans `sav_files`. Aucun thumbnail pré-généré, aucun proxy authentifié. La SPA fait :

```vue
<!-- client/src/features/back-office/views/SavDetailView.vue (probable) -->
<img :src="file.webUrl" :alt="`Aperçu ... ${file.filename}`" />
```

→ chaque vignette = requête cross-origin vers SharePoint sans auth → ORB bloque.

**À investiguer en priorité (Step 1 DS)** :
1. Confirmer le fichier source SPA qui rend les vignettes (`grep -rn "webUrl" client/src/features/back-office/`)
2. Confirmer schéma `sav_files` (colonnes : `web_url`, `onedrive_item_id`?, `drive_id`?, `thumbnail_url`?)
3. Vérifier si `_lib/onedrive-ts.ts` Story 2.4 stocke déjà `onedrive_item_id` + `drive_id` à l'upload (sinon migration additive)
4. Vérifier si Microsoft Graph thumbnails endpoint `/drives/{driveId}/items/{itemId}/thumbnails/0/medium/content` est accessible avec le token applicatif déjà en place (`_lib/graph.js`)

## Solutions candidates (à arbitrer Step 1 DS)

**Option A — Backend proxy `/api/sav/files/:id/thumbnail` via Graph API** (recommandé)

Nouveau endpoint serverless qui :
1. Charge la row `sav_files` (`onedrive_item_id` + `drive_id`)
2. Appelle Graph : `GET /drives/{driveId}/items/{itemId}/thumbnails/0/medium/content`
3. Stream la réponse avec `Content-Type: image/jpeg` + `Cache-Control: private, max-age=300`
4. RBAC standard (operator session)

SPA bascule :
```vue
<img :src="`/api/sav/files/${file.id}/thumbnail`" />
```

**Pros** : marche partout, leverage Graph SDK existant Story 2.4, auth native, cache-friendly, simple à tester.
**Cons** : lambda overhead ~200-400ms par image (premier render), bandwidth doublée (Graph → lambda → user). Mitigé par `Cache-Control: max-age=300` côté browser.

**Option B — Pre-generated thumbnails stockés en base ou CDN public**

À l'upload (Story 2.4 / capture flow) :
1. Générer thumbnail 200×200 via `sharp` ou similaire
2. Stocker base64 dans `sav_files.thumbnail_b64` OU uploader sur path public CDN (Supabase Storage signed bucket)
3. SPA lit directement

**Pros** : zéro runtime cost, fast.
**Cons** : double le storage, **migration nécessaire pour les fichiers existants** (genre les 4 fichiers SAV-2026-00001 actuels n'auront pas de thumbnail), pipeline upload plus complexe, dépendance `sharp` lambda layer.

**Option C — Signed embed URLs via Graph `createLink`**

À chaque render `/admin/sav/:id`, le handler appelle Graph :
```
POST /drives/{driveId}/items/{itemId}/createLink
{ "type": "view", "scope": "anonymous", "expirationDateTime": "<+15min>" }
```

Retourne une URL signée directement viewable. SPA utilise cette URL.

**Pros** : pas de bandwidth lambda, SharePoint sert.
**Cons** : N appels Graph par render (1 par fichier) = slow sur SAV avec 10+ photos (~2-3s overhead), cache management complexe (links expirent), permissions sharing parfois bloquées par tenant policy.

**Recommandation auteur (à valider Step 1 DS)** : **Option A** — proxy `/api/sav/files/:id/thumbnail`. Single endpoint, simple, marche définitivement, leverage infra existante. Cache 5min côté browser couvre la latence.

## Critères d'acceptation (à ajuster en bmad-create-story)

- **AC #1** — Endpoint `GET /api/sav/files/:id/thumbnail` retourne 200 + image bytes (`Content-Type: image/jpeg`) pour fichier existant + RBAC operator OK.
- **AC #2** — 401 si pas auth operator ; 404 si `:id` inexistant ; 403 si fichier appartient à SAV d'un autre groupe (RLS-like check) — cohérent Stories 7-3a/b/c RBAC.
- **AC #3** — Réponse `Cache-Control: private, max-age=300` pour mitiger latence répétée.
- **AC #4** — SPA `SavDetailView.vue` bascule `<img src=webUrl>` → `<img src="/api/sav/files/${id}/thumbnail">` — fallback "Aperçu indisponible" si 404/erreur (pattern existant V1.3 UAT confirmé).
- **AC #5** — Test integration : mock Graph thumbnails endpoint, vérifier stream + headers + 401/404/403 cas.
- **AC #6** — Test E2E preview Vercel : `/admin/sav/:id` affiche les 4 vignettes du SAV-2026-00001 sur browser fraîche **sans** session Microsoft.

## Patterns à suivre (à confirmer Step 1 DS)

**Pattern à poser (NEW)** : **PATTERN-V5 — Backend proxy pour ressources SharePoint/OneDrive cross-origin**.
Tout asset OneDrive consommé en `<img>` ou `<embed>` SPA passe par un endpoint serverless authenticated qui :
1. Authorise via session operator
2. Re-fetch via Graph API avec token applicatif
3. Stream avec `Content-Type` adapté + `Cache-Control` court

Pas de lien direct SPA → SharePoint webUrl pour les ressources rendues inline.

**Patterns réutilisés** :
- Story 2.4 — `_lib/onedrive-ts.ts` + `_lib/graph.js` infrastructure Graph SDK
- Story 4.5 PDF generation — pattern stream binary depuis lambda (`res.setHeader('Content-Type', ...) ; stream.pipe(res)`)
- Stories 7-3a/b/c RBAC — `ADMIN_ONLY_OPS` / operator session validation
- V1.3 PATTERN-V3-bis — smoke-test cold-start endpoint extension (ajouter probe `/api/sav/files/:id/thumbnail` au cutover smoke)

## Out-of-Scope V1.5

- **OOS #1** — Thumbnails pré-générés à l'upload (Option B) — V2 si Option A latency rédhibitoire
- **OOS #2** — Migration des fichiers existants vers thumbnails locaux — Option B uniquement
- **OOS #3** — Embed URL signed (Option C) — V2
- **OOS #4** — Support fichiers non-images (PDF, Excel previews) — V2 ou jamais (clic "Ouvrir" suffit)
- **OOS #5** — Resize/crop client-side — V2
- **OOS #6** — Lazy loading intersection observer — bonus V2 si performance pose problème

## Bloque

- Adoption opérateur back-office (UX dégradée)
- Cutover prod tant que personnes formées sur Mac perso ou poste partagé sans session Microsoft

## Prérequis

- Aucun nouveau prérequis schéma : si `sav_files` stocke déjà `onedrive_item_id` + `drive_id` (à confirmer Step 1), pas de migration
- Sinon migration additive `ALTER TABLE sav_files ADD COLUMN onedrive_item_id text, drive_id text` + backfill depuis `webUrl` (parsing) ou re-fetch Graph

## Estimation

- **S** (small, 0.5j) si `onedrive_item_id` + `drive_id` déjà stockés Story 2.4 — 1 endpoint + 1 ligne SPA + tests
- **M** (medium, 1j) si migration additive nécessaire + backfill — +0.5j

## Tests / Validation

- **Test integration handler** : mock Graph thumbnails stream, assert `Content-Type: image/jpeg` + cache headers + RBAC 401/403/404
- **Test E2E browser fraîche** : Playwright `/admin/sav/:id` charge 4 vignettes sans session Microsoft (extension sav-happy-path)
- **Smoke test preview** : extension `assertColdStartHealthy` V1.3 → ajout step thumbnail probe (1 fichier connu)

## Risques résiduels post-fix

- **R-1** : latency proxy ~300ms / image x 10 fichiers = 3s page load — mitigation `<img loading="lazy">` + cache 5min
- **R-2** : Graph token rotation — déjà géré Story 2.4 via `_lib/graph.js` cache + retry
- **R-3** : ORB sur autres ressources SharePoint (PDF previews ?) — out-of-scope V1.5, à auditer V2
- **R-4** : sav_files plus anciennement uploadés (si Story 2.4 ne stockait pas encore `onedrive_item_id`) — backfill requis

## Notes diagnostic V1.3 UAT (2026-05-05)

Découvert pendant validation runtime V1.3 sur preview Vercel via MCP chrome-devtools. SAV-2026-00001 (id=18), 4 fichiers SAV testés :
- `505_25S25_30_6_IMG_4889.JPG` (4.2 Mo)
- `505_25S25_30_6_mix-citron-orange-clementine-cn.jpg` (217.6 Ko)
- `505_25S25_30_6_mix-pomelo-oranges-citron-cn.jpg` (206.3 Ko)
- `505_25S25_30_6_pomelo-jaune-5k-bio.jpg` (194.9 Ko)

Tous 4 → `net::ERR_BLOCKED_BY_ORB` côté browser. Liens "Ouvrir" fonctionnent (browser suit redirect normal). Bug `<img src>` uniquement.

---

*Spec rédigée 2026-05-05 fin session UAT V1.3 (post commit `216f429` Vercel rebuild). À reprendre via `bmad-create-story` (workflow Steps 1-7) pour produire la story file complète prête à dev. Recommandation : pipeline en mode CHECKPOINT (score complexité prévisible 5-6/14 — code surface 2 fichiers, domain risk proxy auth 2/4, decision density 2/3 entre Options A/B/C, external deps 1/2, testing 1/2).*
