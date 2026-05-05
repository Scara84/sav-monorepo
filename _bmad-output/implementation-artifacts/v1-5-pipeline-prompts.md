# V1.5 — Prompts ready-to-paste pour nouvelle session

> Spec brute : `_bmad-output/implementation-artifacts/v1-5-admin-sav-thumbnails-graph-proxy.md`
> Statut sprint-status : `backlog`
> Story-ID à utiliser : `V1.5` (ou `v1-5-admin-sav-thumbnails-graph-proxy`)
>
> Lance les prompts dans l'ordre. Auto mode recommandé (`/auto on` au début) si tu veux que ça file. Sinon CHECKPOINT mode validera chaque step.

---

## Prompt #1 — Lancer le pipeline complet

```
/bmad-story-pipeline V1.5
```

Le score complexité prévu = 5-6/14 → mode CHECKPOINT recommandé. Si tu préfères YOLO (zéro pause), réponds `s` quand le pipeline demande le mode.

---

## Prompt #2 — Decisions à appliquer si Step 1 te demande

Quand Step 1 (pipeline-architect Opus) te demande tes recos, voici les réponses sur les 4 options identifiées :

```
DN-1 = Option A : backend proxy /api/sav/files/:id/thumbnail via Graph API thumbnails endpoint
  → cache 5min, leverage Story 2.4 _lib/onedrive-ts.ts + _lib/graph.js, simple
  → Option B (pre-generated thumbnails à l'upload) déférée V2 (migration files existants trop complexe)
  → Option C (signed embed URLs Graph createLink) déférée V2 (N appels par render trop slow)

DN-2 = Confirme Story 2.4 stocke onedrive_item_id + drive_id dans sav_files
  → si OUI : pas de migration (estimation S 0.5j)
  → si NON : migration additive ALTER TABLE sav_files ADD COLUMN onedrive_item_id text, drive_id text + backfill (estimation M 1j)
  → Step 1 DS doit grep sav_files schema pour trancher

DN-3 = Lazy thumbnail (Story 7-7 pattern smoke-test cold-start probe extension)
  → Ajouter probe /api/sav/files/<known-test-id>/thumbnail au runSmokeTest comme Step 8 ou hardening
  → cohérent V1.3 PATTERN-V3-bis

DN-4 = SPA fallback handler 404 → afficher placeholder "Aperçu indisponible" (pattern existant V1.3 UAT)
  → pas de retry SPA, pas de loader spinner par fichier (KISS)
```

---

## Prompt #3 — Si pipeline t'arrête sur un blocker CR adversarial

Le CR Opus va probablement chercher :
- RBAC bypass : un opérateur peut-il accéder à `/api/sav/files/:id/thumbnail` d'un fichier d'un autre groupe ? → check `sav_files.sav_id → sav.member_group` cohérent 7-3a/b/c
- Path traversal sur `:id` → schéma Zod strict UUID/integer
- Token Graph leak : assert le response stream NE contient PAS le bearer token
- Cache poisoning : `Cache-Control: private` (pas `public`) — sinon proxy CDN cache pour tous opérateurs
- DoS : grand fichier → cap timeout Graph 5s + content-length hard limit 5 MB
- Fail open vs fail closed : si Graph API down, retourne 503 (pas 200 placeholder) pour SPA fallback déclencher

Réponses types si CR demande :

```
H-1 RBAC : check operator session has access to sav_files.sav_id via member_group join
H-2 Path traversal : Zod schema integer().positive() ou UUID strict
H-3 Token leak : Graph response.body.pipe(res) après res.setHeader — pas de log du body
H-4 Cache : Cache-Control: private, max-age=300 (jamais public)
H-5 Timeout : Graph fetch AbortController 5s + Content-Length check 5 MB
H-6 Fail closed : 503 SERVICE_UNAVAILABLE si Graph timeout/error → SPA placeholder
```

---

## Prompt #4 — Validation runtime preview Vercel post-pipeline

Quand le pipeline marque V1.5 done :

```bash
# 1. Push si pas auto-pushé
git push origin refonte-phase-2

# 2. Wait Vercel build (~2-3 min) → preview URL stable
# https://sav-monorepo-client-git-refonte-phase-2-ants-projects-3dc3de65.vercel.app

# 3. UAT browser MCP — login + naviguer /admin/sav/18 + vérifier 4 thumbnails affichées
# (le browser MCP doit être libre — sinon pkill -f chrome-devtools-mcp/chrome-profile)
```

Critère succès AC #6 :
- Les 4 thumbnails de SAV-2026-00001 doivent **s'afficher** sur browser fraîche
- 0 erreur `net::ERR_BLOCKED_BY_ORB` en network panel
- Status 200 sur `/api/sav/files/{id}/thumbnail` avec `Content-Type: image/jpeg`

---

## Prompt #5 — Post-V1.5 (optionnel, si tu veux tag v1.0.0 dans la foulée)

Si DPIA Story 7-7 signée :

```bash
# Vérifier le gate DPIA
node scripts/verify-dpia-signed.mjs docs/dpia/v1.md

# Si PASS → tag
git tag -a v1.0.0 -m "Release V1.0.0 — capture self-service + back-office RBAC + cutover infra"
git push origin v1.0.0
```

Sinon → cette étape attend la signature humaine.

---

## Notes contextuelles importantes

- **V1.3 done** : `/admin/sav/:id` charge sans 500 sur preview Vercel (commits `d3fa073` + `216f429`)
- **V1.5 = UX adoption, pas ship-blocker fonctionnel** — l'app marche sans (clic "Ouvrir" ouvre les fichiers individuellement)
- **Story 3.7b backlog** = vrai ship-blocker fonctionnel pour cutover prod (UI back-office opérateur). À planifier après V1.5 ou en parallèle.
- **Issue connue Vercel preview** : alias `git-refonte-phase-2` URL doit matcher exactement `APP_BASE_URL` env var (CSRF strict). Si tu changes l'URL canonique, mets à jour l'env var Preview en dashboard Vercel + force redeploy via empty commit (`git commit --allow-empty -m "chore: rebuild"`).
- **Browser MCP** : `~/.claude/CLAUDE.md` règle stricte — ne kill pas le process MCP toi-même, demande autorisation explicite si conflit.

---

*Préparé 2026-05-05 fin session V1.3. Pour exécution dans nouvelle session Claude Code.*
