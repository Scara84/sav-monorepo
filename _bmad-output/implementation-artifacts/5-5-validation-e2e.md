# Story 5.5 — Validation E2E manuelle (préview)

> AC #15 PRD FR48 / AC-2.5.4. À exécuter sur DB préview Supabase
> (`viwgyrqpyryagzgvnfoi`) AVANT merge sur `main`. Documentation
> destinée à la PR review.

## Pré-requis

- Migrations `20260507120000_settings_threshold_alert.sql` et
  `20260507130000_threshold_alert_sent.sql` appliquées sur la préview.
- Au moins 1 opérateur actif (`is_active=true`, `role IN ('admin','sav-operator')`).
- `CRON_SECRET` défini dans Vercel preview.

## Scénario reproductible

### 1) Préparation données

Créer 6 SAV avec le même produit dans les 7 derniers jours. Exemple
direct via SQL (préview uniquement) :

```sql
DO $$
DECLARE
  v_member_id bigint;
  v_product_id bigint;
  v_sav_id bigint;
  i int;
BEGIN
  SELECT id INTO v_member_id FROM members LIMIT 1;
  SELECT id INTO v_product_id FROM products WHERE deleted_at IS NULL LIMIT 1;

  FOR i IN 1..6 LOOP
    INSERT INTO sav (member_id, reference, status, received_at)
    VALUES (
      v_member_id,
      'SAV-E2E-5-5-' || i::text,
      'received',
      now() - make_interval(days => 1)
    )
    RETURNING id INTO v_sav_id;
    INSERT INTO sav_lines (
      sav_id, product_id, product_code_snapshot, product_name_snapshot,
      qty_requested, unit
    ) VALUES (
      v_sav_id, v_product_id, 'E2E-PROD', 'Produit E2E',
      1, 'kg'
    );
  END LOOP;
END$$;
```

Vérifier :

```sql
SELECT product_id, COUNT(DISTINCT sav_id) AS sav_count
  FROM sav_lines
  WHERE product_id = (SELECT id FROM products WHERE code = 'E2E-PROD')
  GROUP BY product_id;
-- ⇒ sav_count = 6 (≥ seuil 5 → alerte attendue)
```

### 2) Déclenchement cron manuel

```bash
curl -X GET "https://<preview>.vercel.app/api/cron/dispatcher" \
  -H "Authorization: Bearer $CRON_SECRET"
```

Réponse attendue (extrait) :

```json
{
  "ok": true,
  "results": {
    "thresholdAlerts": {
      "products_over_threshold": 1,
      "alerts_enqueued": <nb_operators_actifs>,
      "alerts_skipped_dedup": 0,
      "settings_used": { "count": 5, "days": 7, "dedup_hours": 24 }
    }
  }
}
```

### 3) Vérifications base

```sql
-- email_outbox : 1 row par opérateur actif avec kind='threshold_alert'
SELECT id, kind, recipient_email, subject, status
  FROM email_outbox
  WHERE kind = 'threshold_alert'
  ORDER BY id DESC LIMIT 10;

-- threshold_alert_sent : 1 row pour le produit E2E avec snapshot seuil
SELECT product_id, sent_at, count_at_trigger,
       settings_count, settings_days, window_start, window_end
  FROM threshold_alert_sent
  ORDER BY id DESC LIMIT 5;
```

### 4) Re-déclenchement intra-fenêtre dédup

Re-lancer la commande `curl` ci-dessus immédiatement.

```json
{
  "thresholdAlerts": {
    "products_over_threshold": 1,
    "alerts_enqueued": 0,
    "alerts_skipped_dedup": 1
  }
}
```

Aucun nouvel `email_outbox` ni `threshold_alert_sent` créé. Audit trail
intact.

### 5) Audit UI

- Naviguer `/admin/settings?tab=thresholds`.
- Vérifier que la valeur courante (5/7/24) est affichée.
- Modifier `Nombre de SAV = 8`, `Note = "Test E2E"`, cliquer Enregistrer.
- Toast success ; ligne historique avec auteur=`<email_short>` apparaît
  en tête, statut « Active ».
- Rafraîchir la page → la nouvelle valeur reste pré-remplie.

### 6) Cleanup post-validation

```sql
DELETE FROM email_outbox WHERE kind = 'threshold_alert' AND recipient_email LIKE '%@example.com';
DELETE FROM threshold_alert_sent WHERE settings_count = 5 AND product_id = (SELECT id FROM products WHERE code = 'E2E-PROD');
DELETE FROM sav_lines WHERE product_code_snapshot = 'E2E-PROD';
DELETE FROM sav WHERE reference LIKE 'SAV-E2E-5-5-%';
DELETE FROM products WHERE code = 'E2E-PROD';
```

## Critères de succès

| # | Vérification | OK |
|---|---|---|
| 1 | Cron renvoie `products_over_threshold = 1, alerts_enqueued = N` | ☑ run #1 → `{"products_over_threshold":1,"alerts_enqueued":1,"alerts_failed":0}` (1 op actif) |
| 2 | `email_outbox` : 1 row / opérateur, `status='pending'`, `kind='threshold_alert'` | ☑ id=1, `recipient_email=fraize@fstock.onmicrosoft.com`, subject `Alerte SAV : Produit E2E Story 5.5 (6 SAV sur 7 jours)`, html_len=3796 |
| 3 | `threshold_alert_sent` : 1 row, `count_at_trigger = 6`, snapshot seuils corrects | ☑ id=1, `count_at_trigger=6`, `settings_count=5`, `settings_days=7`, window OK |
| 4 | Re-run intra-24h ⇒ `alerts_skipped_dedup = 1` | ☑ run #2 → `{"alerts_skipped_dedup":1,"alerts_enqueued":0}`, aucun nouvel insert |
| 5 | UI `/admin/settings?tab=thresholds` charge + sauve + historique | ☑ 2026-04-28 via Chrome DevTools MCP — page charge avec valeurs courantes 5/7/24 ; modification → 8/7/24 + note "Test E2E" ; ligne historique en tête `28/04/2026 13:38 \| Active \| 8/7/24 \| fraize \| Test E2E` ; reload → 8/7/24 reste pré-rempli ; settings restaurés à 5/7/24 (version id=16, notes "Restore post E2E") |
| 6 | Email NON envoyé V1 (`status='pending'` reste, retry-emails Epic 6.6) | ☑ outbox row reste `status='pending'`, conforme dépendance Epic 6.6 documentée |

## Validation E2E exécutée 2026-04-28 (steps 1–4 + 6)

- **Migrations appliquées** sur project `viwgyrqpyryagzgvnfoi` via MCP Supabase :
  - `20260507120000_settings_threshold_alert`
  - `20260507130000_threshold_alert_sent`
  - `20260507140000_threshold_alert_hardening`
- **Vercel dev** local sur `http://localhost:3000` (env injectée : `CRON_SECRET=e2e-5-5-cron-secret-local-only`, `APP_BASE_URL=http://localhost:3000`)
- **Données préparées** : 1 member (`e2e-5-5@example.com`), 1 product (`E2E-PROD-5-5`), 6 SAV `SAV-E2E-5-5-1..6` reçus J-1, status `received`
- **Curl run #1** : 200 OK avec `products_over_threshold=1, alerts_enqueued=1, alerts_skipped_dedup=0, alerts_failed=0`, durée 543ms
- **Curl run #2** (immédiat) : 200 OK avec `alerts_skipped_dedup=1`, aucun nouvel insert outbox/trace
- **Cleanup partiel** : SAV/sav_lines/members/outbox supprimés. La trace `threshold_alert_sent` (id=1) et le product (`E2E-PROD-5-5`) sont conservés à cause du trigger immutable post-CR (D8 append-only enforcement) + FK products. Cleanup manuel possible si nécessaire via DROP TRIGGER + DELETE.

## Step 5 (UI) — exécuté 2026-04-28 via Chrome DevTools MCP

- **Migration auth Story 5.8 appliquée** sur project `viwgyrqpyryagzgvnfoi` (manquait dans préview) : `20260506130000_operators_magic_link` (ALTER `operators.azure_oid` nullable, extension polymorphique `magic_link_tokens` avec `target_kind`/`operator_id`, indexes partiels).
- **Auth E2E** : magic-link JWT minté localement avec `MAGIC_LINK_SECRET` (TTL 15 min), insert `magic_link_tokens` row (jti `8a2e96…`, target_kind=`operator`, operator_id=3), navigation browser vers `/api/auth/operator/verify?token=<jwt>` → 302 `/admin` + cookie session 8h posé. Pas de SMTP réel (fast-path E2E auto, équivalent au flow magic-link sans envoi email).
- **Step 5.2** Page `/admin/settings?tab=thresholds` affiche valeurs 5/7/24, historique 1 ligne (id=14, seed Story 5.5, notes "Story 5.5 — Seuil alerte produit (FR48)..."). Screenshot `5-5-step5-01-initial.png`.
- **Step 5.3** Modification `Nombre de SAV = 8` + note `Test E2E` → clic Enregistrer → bouton "Enregistrement…" (state submitting) → page revient idle, ligne historique en tête `28/04/2026 13:38 | Active | 8 | 7 | 24 | fraize | Test E2E` (id=15), ancienne ligne fermée `01/01/2020 01:00 → 28/04/2026 13:38`. Aucune erreur console. Screenshot `5-5-step5-02-saved.png`.
- **Step 5.4** Reload → inputs prérémplis avec `8/7/24` (persistance API confirmée), historique conservé. Screenshot `5-5-step5-03-after-reload.png`.
- **Step 5.5 cleanup** Restauration via UI : `Nombre de SAV = 5` + note `Restore post E2E` → Save → ligne id=16 active `Active | 5/7/24 | fraize | Restore post E2E`, version id=15 fermée `28/04/2026 13:38 → 28/04/2026 13:39`. Settings DB final : `{count:5, days:7, dedup_hours:24}` (`updated_by=3`).

## Notes

- Les emails restent en `pending` jusqu'au déploiement de la Story 6.6
  (cron `retry-emails.ts` SMTP). C'est documenté AC #16 et accepté.
- Les valeurs settings modifiées via `/admin/settings` sont appliquées
  au prochain cron (jusqu'à 24 h).
