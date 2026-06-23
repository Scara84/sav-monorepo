# Runbook — Réponse aux incidents

> **Audience** : Tech-lead / Admin Fruitstock
> **Objectif** : Diagnostiquer et résoudre les incidents prod : consultation dashboards, symptômes courants, escalation, post-mortem
> **Prérequis** : Accès admin applicatif, accès Vercel logs, accès Supabase dashboard

---

## TL;DR

1. Identifier le type d'incident via les symptômes (§2)
2. Consulter `/admin/dashboard` et `/admin/audit-trail` (§1)
3. Suivre la procédure spécifique ou escalader (§3)
4. Post-mortem dans les 48h (§5)

---

## §1 — Consultation des dashboards admin

### 1.1 Dashboard principal (Story 5.3)

URL : `https://sav.fruitstock.eu/admin/dashboard`

Métriques disponibles :
- Nombre de SAV par statut
- SAV en retard (> 7 jours)
- Avoirs émis ce mois
- Taux de clôture

### 1.2 Audit trail (Story 7-5)

URL : `https://sav.fruitstock.eu/admin/audit-trail`

Permet de tracer :
- Toutes les actions admin (anonymisations, rotations settings)
- Les transitions de statut SAV
- Les émissions d'avoirs
- Les tentatives d'authentification

**Filtres utiles** :
- Par `entity_type` : `members`, `sav`, `credit_notes`, `credit_number_sequence`
- Par `action` : `anonymize`, `cutover_seed`, `issue_credit`, `transition_status`
- Par plage de dates

### 1.3 ERP Queue (Story 7-5 mode-b)

URL : `https://sav.fruitstock.eu/admin/erp-queue`

Permet de surveiller :
- Les pushs ERP en attente
- Les erreurs de push (si Story 7-1 activée)
- Relancer un push en échec via le bouton "Retry"

---

## §2 — Symptômes courants et diagnostics

### 2.1 Magic-link ne fonctionne pas

**Symptômes** : L'email de connexion n'arrive pas, ou le lien retourne une erreur.

**Diagnostic** :
1. Vérifier les logs Vercel : `https://vercel.com/fruitstock/sav/logs`
2. Chercher les erreurs `SMTP` ou `MAGIC_LINK`
3. Vérifier les variables SMTP dans Vercel dashboard

**Actions** :
- Problème SMTP → voir [email-outbox-runbook.md](../email-outbox-runbook.md) pour la procédure détaillée
- Problème JWT secret → voir [token-rotation.md](token-rotation.md) §3

### 2.2 Émission avoir échoue

**Symptômes** : Erreur 500 ou 422 sur POST `/api/sav/issue-credit`.

**Diagnostic** :
```bash
# Vérifier l'état de la séquence
psql "$SUPABASE_DB_URL" -c \
  "SELECT last_number FROM credit_number_sequence WHERE id = 1;"
# Si last_number = 0 → séquence non seedée (cutover non effectué)
# Si last_number > 0 → vérifier les logs handler
```

**Actions** :
- Séquence non seedée → exécuter [cutover.md](cutover.md) §3.2
- Erreur RPC → vérifier les logs Supabase Functions

### 2.3 Upload OneDrive échoue

**Symptômes** : Les bons de retour ne s'uploadent pas (erreur dans la capture SAV).

**Diagnostic** :
1. Vérifier les logs Vercel pour erreurs MSAL/Microsoft Graph
2. Vérifier expiration de `MICROSOFT_CLIENT_SECRET` dans Azure Portal

**Actions** :
- Secret expiré → [token-rotation.md](token-rotation.md) §5
- Erreur temporaire → réessayer après 5 min (Microsoft peut avoir des timeouts)

### 2.4 Dashboard vide / données manquantes

**Symptômes** : Tableau de bord SAV ne montre aucun SAV.

**Diagnostic** :
1. Vérifier la connexion Supabase : `https://app.supabase.com/project/<ref>/editor`
2. Vérifier les variables d'environnement Vercel (SUPABASE_URL, ANON_KEY)
3. Vérifier les policies RLS si certains rôles ne voient pas les données

**Actions** :
- Variables manquantes → redéployer avec les bonnes valeurs
- RLS trop restrictive → consulter l'audit trail pour les accès refusés

### 2.5 Emails transactionnels non envoyés

**Symptômes** : Les adhérents ne reçoivent pas les confirmations d'avoirs.

**Diagnostic** :
1. **Consultation `email_outbox`** : pas d'admin UI dédiée. Voir [email-outbox-runbook.md](../email-outbox-runbook.md) ou requête Supabase SQL editor :
   ```sql
   SELECT * FROM email_outbox WHERE status = 'failed' ORDER BY created_at DESC LIMIT 50;
   ```
2. Vérifier les statuts : `pending` (en attente cron), `sent` (OK), `failed` (erreur)

**Actions** :
- Problème SMTP → voir [email-outbox-runbook.md](../email-outbox-runbook.md) pour la procédure complète et le diagnostic détaillé

---

## §3 — Escalation matrix

| Niveau | Critère | Escalade vers |
|--------|---------|--------------|
| P1 | DB down, perte données, faille sécurité | Tech-lead + Supabase support immédiat |
| P2 | Feature critique indisponible (avoirs, SAV) | Tech-lead dans l'heure |
| P3 | Feature secondaire dégradée | Tech-lead dans la journée |
| P4 | Question usage, formation | Admin → opérateur-daily.md |

### Contacts Supabase support

- Dashboard : `https://supabase.com/dashboard/support`
- Email urgence : `support@supabase.io`
- Inclure : project ref, timestamp incident, logs, impact estimé

---

## §4 — Actions de premier niveau (sans code)

### Redémarrer le déploiement Vercel

```bash
# Via Vercel dashboard → Deployments → Redeploy last deployment
# OU via CLI :
vercel --prod
```

### Vider le cache Vercel Edge

```bash
# Dashboard Vercel → Settings → Functions → Purge Edge Cache
```

### Vérifier l'état des services tiers

- Supabase status : `https://status.supabase.com`
- Vercel status : `https://www.vercel-status.com`
- Microsoft 365 status : `https://status.office.com`

---

## §5 — Template post-mortem

À remplir dans les **48 heures** suivant l'incident et partagé dans #incident.

```markdown
## Post-mortem — Incident <date>

### Résumé
- Durée : <heure début> → <heure fin>
- Impact : <description brève>
- Sévérité : P1/P2/P3

### Chronologie
- <heure> : Incident détecté
- <heure> : Diagnostic initial
- <heure> : Action corrective lancée
- <heure> : Service restauré

### Cause racine
<description technique>

### Actions correctives immédiates
- [ ] <action 1>
- [ ] <action 2>

### Actions préventives (long terme)
- [ ] <action 1>

### Leçons apprises
<texte libre>
```

---

## Si ça casse

### Accès admin refusé (401/403)

- Re-connexion via magic-link admin
- Vérifier le rôle dans la table `operators`

### Audit trail vide pour une période

- Les données audit sont conservées 10 ans (NFR-D10)
- Si vides sur une période récente → incident potentiel de logging
- Consulter les logs Vercel Functions pour erreurs INSERT audit_trail

### Supabase dashboard inaccessible

- Vérifier le status Supabase : `https://status.supabase.com`
- Si maintenance planifiée : attendre
- Si incident : contacter Supabase support

---

**Dernière mise à jour** : 2026-05-01 — Story 7.7 V1
