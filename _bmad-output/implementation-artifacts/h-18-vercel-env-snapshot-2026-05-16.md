# Snapshot Vercel env vars — 2026-05-16

> **A remplir lors de la checklist dashboard — toutes les ✅/❌ sont à cocher manuellement**
> Dashboard : https://vercel.com/ants-projects-3dc3de65/sav-monorepo-client/settings/environment-variables
>
> PATTERN-H18-B — Ce snapshot est un fichier daté. Ne pas écraser, créer un nouveau snapshot lors du prochain audit.
>
> Rename à faire sur Vercel (h-18 D4) : `VITE_MAINTENANCE_BYPASS_TOKEN → VITE_MAINTENANCE_BYPASS` (Production + Preview + Development)

---

## Méthode

Export manuel dashboard (`Project Settings → Environment Variables`).

---

## Production

| Variable | Présente | Scope | Notes |
|---|---|---|---|
| VITE_API_KEY | | | |
| VITE_MAINTENANCE_MODE | | | |
| VITE_MAINTENANCE_BYPASS | | | Renommée depuis VITE_MAINTENANCE_BYPASS_TOKEN (h-18 D4) |
| VITE_SUPABASE_URL | | | Boot-fatal — CRITICAL_VARS |
| VITE_SUPABASE_PUBLISHABLE_KEY | | | Boot-fatal — CRITICAL_VARS |
| SUPABASE_SERVICE_ROLE_KEY | ⚠️ à vérifier | Prod+Preview | Secret server-only CRITIQUE — valeurs distinctes ? |
| SUPABASE_DB_URL | | | Boot-fatal — CRITICAL_VARS |
| MICROSOFT_TENANT_ID | | | CRITICAL_VARS |
| MICROSOFT_CLIENT_ID | | | CRITICAL_VARS |
| MICROSOFT_CLIENT_SECRET | | | CRITICAL_VARS — valeurs distinctes Prod/Preview ? |
| MAGIC_LINK_SECRET | | | CRITICAL_VARS — valeurs distinctes Prod/Preview ? |
| SESSION_COOKIE_SECRET | | | CRITICAL_VARS — valeurs distinctes Prod/Preview ? |
| OPERATOR_SESSION_TTL_HOURS | | | |
| SMTP_HOST | | | |
| SMTP_PORT | | | |
| SMTP_SECURE | | | |
| SMTP_USER | | | |
| SMTP_PASSWORD | | | |
| SMTP_FROM | | | |
| APP_BASE_URL | | | |
| PENNYLANE_API_KEY | | | |
| PENNYLANE_API_BASE_URL | | | |
| SMTP_SAV_HOST | | | |
| SMTP_SAV_PORT | | | |
| SMTP_SAV_SECURE | | | |
| SMTP_SAV_USER | | | |
| SMTP_SAV_PASSWORD | | | |
| SMTP_SAV_FROM | | | |
| SMTP_NOTIFY_INTERNAL | | | |
| SAV_SUBMIT_TOKEN_TTL_SEC | | | |
| RGPD_EXPORT_HMAC_SECRET | | | CRITICAL_VARS — valeurs distinctes Prod/Preview ? |
| RGPD_ANONYMIZE_SALT | | | |
| CRON_SECRET | | | CRITICAL_VARS (DN-1 Option A) — auth Bearer /api/cron/* — valeurs distinctes Prod/Preview ? |
| API_KEY | | | HMAC server-side counterpart de VITE_API_KEY |
| ALLOWED_ORIGINS | | | CSV origins CORS autorisés |
| MICROSOFT_DRIVE_ID | | | ID drive OneDrive (Story 2.4) |
| MICROSOFT_DRIVE_PATH | | | Chemin racine drive OneDrive |
| WEEKLY_RECAP_BYPASS_FRIDAY | | | Toggle Friday-only guard |
| HEALTH_DEBUG | | | Toggle verbose /api/healthcheck |
| SUPABASE_URL | | | Variant non-VITE pour imports serveur |
| VITE_APP_BASE_URL | | | APP_BASE_URL exposée bundle SPA |

---

## Preview

| Variable | Présente | Scope | Notes |
|---|---|---|---|
| VITE_API_KEY | | | |
| VITE_MAINTENANCE_MODE | | | |
| VITE_MAINTENANCE_BYPASS | | | Renommée depuis VITE_MAINTENANCE_BYPASS_TOKEN (h-18 D4) |
| VITE_SUPABASE_URL | | | |
| VITE_SUPABASE_PUBLISHABLE_KEY | | | |
| SUPABASE_SERVICE_ROLE_KEY | | | Valeur distincte de Prod ? |
| SUPABASE_DB_URL | | | |
| MICROSOFT_TENANT_ID | | | |
| MICROSOFT_CLIENT_ID | | | |
| MICROSOFT_CLIENT_SECRET | | | Valeur distincte de Prod ? |
| MAGIC_LINK_SECRET | | | Valeur distincte de Prod ? |
| SESSION_COOKIE_SECRET | | | Valeur distincte de Prod ? |
| OPERATOR_SESSION_TTL_HOURS | | | |
| SMTP_HOST | | | |
| SMTP_PORT | | | |
| SMTP_SECURE | | | |
| SMTP_USER | | | |
| SMTP_PASSWORD | | | |
| SMTP_FROM | | | |
| APP_BASE_URL | | | |
| PENNYLANE_API_KEY | | | |
| PENNYLANE_API_BASE_URL | | | |
| SMTP_SAV_HOST | | | |
| SMTP_SAV_PORT | | | |
| SMTP_SAV_SECURE | | | |
| SMTP_SAV_USER | | | |
| SMTP_SAV_PASSWORD | | | |
| SMTP_SAV_FROM | | | |
| SMTP_NOTIFY_INTERNAL | | | |
| SAV_SUBMIT_TOKEN_TTL_SEC | | | |
| RGPD_EXPORT_HMAC_SECRET | | | Valeur distincte de Prod ? |
| RGPD_ANONYMIZE_SALT | | | |
| CRON_SECRET | | | Valeur distincte de Prod ? |
| API_KEY | | | |
| ALLOWED_ORIGINS | | | |
| MICROSOFT_DRIVE_ID | | | |
| MICROSOFT_DRIVE_PATH | | | |
| WEEKLY_RECAP_BYPASS_FRIDAY | | | |
| HEALTH_DEBUG | | | |
| SUPABASE_URL | | | |
| VITE_APP_BASE_URL | | | |

---

## Secret diff Prod/Preview

> AC#3 — vérification visuelle des 4 premiers chars affichés par Vercel UI (pattern `abc***`).
> Remplir avec le préfixe affiché par le dashboard. Si Prod == Preview → rotation Preview obligatoire.

| Secret | Préfixe Prod (4 chars) | Préfixe Preview (4 chars) | Statut |
|---|---|---|---|
| SUPABASE_SERVICE_ROLE_KEY | (à compléter) | (à compléter) | A VÉRIFIER |
| MAGIC_LINK_SECRET | (à compléter) | (à compléter) | A VÉRIFIER |
| SESSION_COOKIE_SECRET | (à compléter) | (à compléter) | A VÉRIFIER |
| RGPD_EXPORT_HMAC_SECRET | (à compléter) | (à compléter) | A VÉRIFIER |
| MICROSOFT_CLIENT_SECRET | (à compléter) | (à compléter) | A VÉRIFIER |
| CRON_SECRET | (à compléter) | (à compléter) | A VÉRIFIER — désormais CRITICAL_VARS (DN-1 Option A) |

---

## Cleanup AZURE_* legacy

> AC#4 — Story 5.8 a migré le code vers MICROSOFT_*. Les vars AZURE_* sont potentiellement
> présentes sur Vercel en tant que legacy. A vérifier et supprimer si présentes.

| Variable | Avant (présente ?) | Après (supprimée ?) | Notes |
|---|---|---|---|
| AZURE_TENANT_ID | (à vérifier) | | Remplacée par MICROSOFT_TENANT_ID |
| AZURE_CLIENT_ID | (à vérifier) | | Remplacée par MICROSOFT_CLIENT_ID |
| AZURE_CLIENT_SECRET | (à vérifier) | | Remplacée par MICROSOFT_CLIENT_SECRET |

Avant suppression : confirmer que MICROSOFT_TENANT_ID + MICROSOFT_CLIENT_ID + MICROSOFT_CLIENT_SECRET sont bien présentes (Production + Preview).

---

## Findings

> A remplir lors de la checklist. Documenter ici toutes les anomalies trouvées.

- (aucun finding identifié à ce stade — à compléter lors de la checklist dashboard)
