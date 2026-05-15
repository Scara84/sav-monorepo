# Audit transverse — `sav_files.source` valeurs hardcodées

**Story H-15** — AC#3  
**Date** : 2026-05-15  
**Auditeur** : BMAD DEV Step 3  
**Périmètre** : Toutes les migrations SQL (`client/supabase/migrations/*.sql`) + handlers TS (`client/api/_lib/**/*.ts`) qui INSERT dans `sav_files`.

---

## CHECK constraint de référence

Défini dans `20260421140000_schema_sav_capture.sql:197` :

```sql
source text NOT NULL DEFAULT 'capture'
  CHECK (source IN ('capture','operator-add','member-add'))
```

Valeurs autorisées : `'capture'`, `'operator-add'`, `'member-add'`

---

## Résultats — Migrations SQL

### Fonctions RPC — Corpus final (dernière définition wins — DN-A=A)

La RPC `capture_sav_from_webhook` a été re-CREATEd plusieurs fois. Seule la **dernière définition** est active. Les définitions intermédiaires sont des artefacts d'historique mais ne sont jamais exécutées.

| Fichier | Ligne | Valeur `source` | Conformité |
|---------|-------|-----------------|------------|
| `20260421150000_rpc_capture_sav_from_webhook.sql` | ~142 | `'capture'` | PASS (version originale — superseded) |
| `20260422130000_sav_schema_prd_target.sql` | ~304 | `'capture'` | PASS (superseded) |
| `20260424130000_rpc_sav_lines_prd_target_updates.sql` | ~247 | `'capture'` | PASS (superseded) |
| `20260505140000_capture_sav_default_notification_prefs.sql` | ~139 | `'capture'` | PASS (superseded) |
| `20260505141000_capture_sav_unit_requested_column_rename.sql` | ~97 | `'capture'` | PASS (superseded) |
| `20260509120000_capture_sav_extend_pricing.sql` | ~161 | `'capture'` | PASS (superseded) |
| `20260516120000_rename_unit_price_ht_to_ttc.sql` | ~528 | `'capture'` | PASS (superseded) |
| `20260518120000_v1-9-b-arbitration-motif.sql` | **564** | **`'webhook'`** | **VIOLATION** (source du bug h-15 — superseded par AC#1) |
| `20260521120000_fix_capture_sav_source_typo.sql` | ~114 | `'capture'` | **PASS (définition active — fix AC#1)** |

### Verdict sur les migrations SQL

La VIOLATION ligne 564 de `20260518120000_v1-9-b-arbitration-motif.sql` est la seule violation identifiée. Elle est **supersedée** par la migration fix `20260521120000_fix_capture_sav_source_typo.sql` (AC#1). La fonction live utilise `'capture'`.

---

## Résultats — Handlers TypeScript

| Fichier | Ligne | Table | Colonne | Valeur | Conformité |
|---------|-------|-------|---------|--------|------------|
| `api/_lib/sav/admin-upload-handlers.ts` | ~271 | `sav_files` | `source` | `'operator-add'` | PASS |
| `api/_lib/self-service/upload-complete-handler.ts` | ~133 | `sav_files` | `source` | `'member-add'` | PASS |
| `api/_lib/self-service/upload-complete-handler.ts` | ~156 | `sav_files` | `source` | `'member-add'` | PASS |

---

## Conclusion

**0 violation active** — toutes les définitions actives et tous les handlers TS conformes au CHECK constraint.

La seule violation historique (`20260518120000:564` — `source='webhook'`) est corrigée par la migration AC#1 (`20260521120000_fix_capture_sav_source_typo.sql`). La définition active de `capture_sav_from_webhook` utilise `source='capture'`.

---

## Notes méthodologie

- **Migrations** : toutes les définitions antérieures de `capture_sav_from_webhook` sont des artefacts d'historique (superseded). Elles ne sont exécutées que lors d'un `db reset` complet où la dernière migration (fix) prend le dessus.
- **Handlers TS** : grep sur `.insert({...source:...})` dans `api/_lib/**/*.ts`. Aucune occurrence de `source='webhook'` ou autre valeur non-autorisée.
- **Gate CI** : `npm run audit:check-constraints` (nouveau script AC#4) catche dynamiquement les violations CHECK IN sur les littéraux INSERT — ferme cette classe de bug pour le futur.
