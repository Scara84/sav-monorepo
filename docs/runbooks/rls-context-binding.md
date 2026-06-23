# Runbook : RLS Context Binding — GUC `app.*` et JWT côté serveur

**Version** : H-16 (2026-05-20)
**Référence** : Story H-16 AC#5(f) — D-USER-3

---

## Contexte

Les fonctions `SECURITY DEFINER` de ce projet utilisent des GUC Postgres (`app.current_member_id`, `app.current_operator_id`, `app.current_actor_type`, `app.actor_operator_id`) pour passer l'identité de l'acteur du handler Node à la RPC PL/pgSQL.

Ces GUC sont posées **par le backend Node** à partir d'un JWT validé côté serveur, jamais par le navigateur.

Depuis H-16, la **défense primaire** est le `REVOKE EXECUTE FROM anon` (et `authenticated` pour les fonctions worker/admin/webhook). Les GUC deviennent une **défense secondaire** (defense-in-depth).

---

## Pattern actuel

### Côté RPC PL/pgSQL

Les fonctions `SECURITY DEFINER` reçoivent l'identité de l'acteur **par paramètre** (ex. `p_actor_operator_id bigint`), et posent la GUC en début de body pour le trigger d'audit :

```sql
PERFORM set_config('app.actor_operator_id', p_actor_operator_id::text, true);
-- ... logique métier ...
PERFORM set_config('app.actor_operator_id', '', false);  -- reset W13
RETURN NEXT;
```

Le `true` (3e argument) = `is_local = true` → la GUC ne survit que dans la transaction courante (pattern H-01/W13).

### Côté Node (handlers API)

Les handlers API appellent la RPC en passant les valeurs d'identité **directement comme paramètres**, après validation du JWT :

```typescript
// Validation JWT côté serveur (avant tout appel RPC)
const session = await verifySession(req)  // throw si invalide
// Appel RPC avec l'identité issue du JWT validé
const { data, error } = await supabaseAdmin().rpc('assign_sav', {
  p_sav_id: ...,
  p_actor_operator_id: session.operatorId,  // toujours du JWT validé
  ...
})
```

Les valeurs passées aux RPC **ne viennent jamais** d'un header HTTP brut, body request, ou query param non validé.

---

## Guardrails anti-régression

### Règle 1 : Pas de `set_config app.*` dans `client/src/`

Le bundle SPA (navigateur) ne doit **jamais** appeler `set_config('app.`, que ce soit via SQL brut ou via `.rpc('set_config', ...)`.

**Gate CI** : test H16-STATIC-07 et H16-STATIC-08 (vitest.config.integration.ts).

```bash
# Vérification manuelle :
grep -rn "set_config.*app\." client/src/
# Résultat attendu : 0 occurrence
```

### Règle 2 : Pas de `SET LOCAL app.*` dans le code API Node

Les templates de requêtes SQL dans `client/api/` ne doivent pas contenir `SET LOCAL app.*` en dur (concaténation de SQL non paramétré).

**Gate CI** : test H16-STATIC-10.

### Règle 3 : Toute nouvelle RPC `SECURITY DEFINER` doit inclure `REVOKE FROM PUBLIC`

Pattern PATTERN-H16-A : lors de la création d'une nouvelle RPC SECURITY DEFINER, la migration doit inclure :

```sql
REVOKE EXECUTE ON FUNCTION public.ma_fonction(...) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ma_fonction(...) TO service_role;
-- (+ TO authenticated si justifié — documenter pourquoi)
```

Ce pattern s'ajoute au `SET search_path = public, pg_temp` inline (W2/W10/W17).

---

## Anti-patterns

### Anti-pattern 1 : `DROP FUNCTION + CREATE FUNCTION`

`DROP FUNCTION + CREATE FUNCTION` **reset les ACL** → les `REVOKE`/`GRANT` précédents sont perdus.

**Toujours utiliser `CREATE OR REPLACE FUNCTION`** pour modifier le body d'une fonction existante.

Si un `DROP` est inévitable (changement de signature), **ré-appliquer les ACL** dans la même migration :

```sql
DROP FUNCTION IF EXISTS public.ma_fonction(ancien_type);
CREATE OR REPLACE FUNCTION public.ma_fonction(nouveau_type) ...;
REVOKE EXECUTE ON FUNCTION public.ma_fonction(nouveau_type) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ma_fonction(nouveau_type) TO service_role;
```

### Anti-pattern 2 : Lire les GUC depuis un input non validé

```typescript
// INTERDIT — valeur non validée
const memberId = req.body.memberId  // peut être manipulé
await supabaseAdmin().rpc('set_config', { key: 'app.current_member_id', value: String(memberId) })

// CORRECT — valeur issue du JWT validé serveur
const session = await verifySession(req)
await supabaseAdmin().rpc('ma_fonction', { p_member_id: session.memberId })
```

### Anti-pattern 3 : GRANT TO PUBLIC par défaut

Postgres accorde `EXECUTE` à `PUBLIC` par défaut sur les nouvelles fonctions. **Ne pas oublier le REVOKE** avant le GRANT restrictif.

---

## Défense primaire vs secondaire

| Couche | Mécanisme | Niveau |
|--------|-----------|--------|
| REVOKE EXECUTE FROM anon/authenticated | Postgres ACL | **Primaire** (H-16) |
| Paramètre `p_actor_*` issu du JWT validé serveur | Validation applicative | **Secondaire** |
| GUC `app.actor_operator_id` pour audit trigger | Defense-in-depth pgBouncer | Tertiaire |

Si les GUC ne sont pas posées (bug dans le handler Node), la **sécurité tient** grâce au REVOKE.
Si le REVOKE venait à être réinitialisé par un DROP+CREATE (anti-pattern 1), la **sécurité tiendrait toujours** grâce à la validation JWT côté Node — mais les fonctions seraient à nouveau exposées à PostgREST direct.

---

## PATTERN-H16-A — RPC `SECURITY DEFINER` privée par défaut (CORRECT)

> ⚠️ **Pattern critique** — pas négociable pour toute nouvelle RPC `SECURITY DEFINER`.

### Anti-pattern (FAUX-SENS de sécurité, H-16 lesson)

```sql
-- ⛔ INCORRECT — REVOKE FROM anon est NO-OP si PUBLIC a déjà EXECUTE
CREATE OR REPLACE FUNCTION public.ma_rpc(...) RETURNS ... AS $$ ... $$
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.ma_rpc(...) FROM anon;       -- ⛔ no-op
GRANT  EXECUTE ON FUNCTION public.ma_rpc(...) TO service_role;
```

**Pourquoi c'est faux** : par défaut Postgres `GRANT EXECUTE ... TO PUBLIC` à la création.
`anon` (et `authenticated`) hérite via PUBLIC → `REVOKE FROM anon` ne touche pas l'héritage.
La fonction reste exécutable par anon malgré le REVOKE apparent.

C'est le bug découvert empiriquement en H-16 sur 7 fonctions (cf. migration `20260522120100_h16_revoke_public_fixup.sql`).

### Pattern correct

```sql
-- ✅ CORRECT — REVOKE FROM PUBLIC d'abord, puis GRANT explicites
CREATE OR REPLACE FUNCTION public.ma_rpc(...) RETURNS ... AS $$ ... $$
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.ma_rpc(...) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.ma_rpc(...) TO service_role;
-- Optionnel selon la nature de la fonction (rpc-metier exposée aux adhérents) :
GRANT  EXECUTE ON FUNCTION public.ma_rpc(...) TO authenticated;

COMMENT ON FUNCTION public.ma_rpc(...) IS
  '... [H-16] REVOKE PUBLIC + GRANT service_role[, authenticated] ...';
```

### Checklist obligatoire pour toute nouvelle RPC `SECURITY DEFINER`

1. ✅ `SECURITY DEFINER`
2. ✅ `SET search_path = public, pg_temp` **inline** dans le CREATE (pas via ALTER post-création)
3. ✅ `REVOKE EXECUTE ... FROM PUBLIC` (pas FROM anon — ça ne suffit pas)
4. ✅ `GRANT EXECUTE ... TO service_role` (et `authenticated` uniquement si l'API REST direct est explicitement souhaitée)
5. ✅ `COMMENT ON FUNCTION ... IS '... [H-XX] ...'` documentant le caller attendu

### Test d'isolation post-création

Toute migration ajoutant une nouvelle RPC `SECURITY DEFINER` DOIT être suivie d'une assertion dans `scripts/security/h16-rpc-isolation-check.sh` :

```bash
# Ajouter à la liste PAIRS=(...)
'ma_rpc|{"p_param":"valeur_minimale_valide"}'
```

Le script doit confirmer `code:42501` (permission denied) sur appel avec publishable_key (rôle anon).

### Anti-pattern 2 — `DROP FUNCTION + CREATE FUNCTION` reset les ACL

```sql
-- ⛔ INCORRECT — DROP supprime aussi les GRANT/REVOKE attachés
DROP FUNCTION IF EXISTS public.ma_rpc(...);
CREATE FUNCTION public.ma_rpc(...) ...;  -- PUBLIC a EXECUTE par défaut !
```

**Préférer `CREATE OR REPLACE FUNCTION`** qui préserve les ACL existantes (PATTERN-CREATE-OR-REPLACE-PRESERVES-GRANT).

Si un DROP+CREATE est inévitable (changement de signature), répéter immédiatement le bloc REVOKE/GRANT.

---

## Pattern futur (référence)

DN-6 story H-16 décrit un wrapper Node théorique `withRlsContext()` qui centraliserait le binding GUC avant chaque appel RPC. Ce wrapper n'a **pas été créé en H-16** (D-USER-4) car le pattern actuel (paramètres RPC + set_config in-body PL/pgSQL) est sécurité-équivalent.

Si un futur refactor bascule vers du binding 100% côté Node (ex. pour des fonctions ne prenant pas `p_actor_operator_id` en paramètre), le pattern DN-6 est le point de départ.

---

## Références

- Story H-16 : `_bmad-output/implementation-artifacts/h-16-supabase-rls-rpc-revoke-anon.md`
- Migration H-16 : `client/supabase/migrations/20260522120000_h16_rpc_revoke_anon.sql`
- Script isolation : `scripts/security/h16-rpc-isolation-check.sh`
- Tests statiques : `client/tests/integration/security/h16-guc-audit.spec.ts`
- Pattern H-01 GUC reset (W13) : `client/supabase/migrations/20260519120000_security_w13_actor_guc_reset_7_rpcs.sql`
