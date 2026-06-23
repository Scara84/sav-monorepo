# Runbook — Administration RGPD

> **Audience** : Admin / DPO Fruitstock
> **Objectif** : Gérer les demandes RGPD (export portabilité, effacement/anonymisation), consulter l'audit trail, respecter les délais CNIL
> **Prérequis** : Rôle admin actif, session navigateur active (magic-link), `RGPD_EXPORT_HMAC_SECRET` disponible (voir [token-rotation.md](token-rotation.md))

---

## TL;DR

- **Demande portabilité** (FR62) : export JSON signé via curl → `verify-rgpd-export.mjs` → envoyer à l'adhérent (délai CNIL : 1 mois)
- **Demande effacement** (FR63) : anonymisation cross-tables via curl → audit row générée automatiquement
- **Consultation audit** : interface `/admin/audit-trail` (Story 7-5)
- **Délai CNIL** : répondre dans **1 mois** calendaire (art. 12 RGPD)

---

## 1. Export RGPD signé (Story 7-6 — portabilité FR62)

### 1.1 Comment obtenir le cookie session admin

L'authentification admin est **session cookie** (magic-link, pas de JWT Bearer).

1. Ouvrir Firefox/Chrome → naviguer vers `https://sav.fruitstock.eu/admin`
2. Se connecter via magic-link (email → lien → connexion)
3. Ouvrir les DevTools navigateur (**F12** → onglet **Application** ou **Storage**)
4. Dans **Cookies** → `https://sav.fruitstock.eu` → copier la valeur du cookie `session`
5. La session expire selon la configuration `SESSION_COOKIE_SECRET` (durée : configurable, défaut ~7 jours)

```bash
# Définir le cookie session dans une variable
SESSION_COOKIE="session=<valeur-copiée-depuis-DevTools>"
```

### 1.2 Générer l'export

```bash
# Remplacer <MEMBER_ID> par l'identifiant numérique de l'adhérent
# SESSION_COOKIE définie à l'étape 1.1

curl -s \
  -H "Cookie: $SESSION_COOKIE" \
  https://sav.fruitstock.eu/api/admin/members/<MEMBER_ID>/rgpd-export \
  -o export-rgpd-<MEMBER_ID>.json

echo "Export généré : export-rgpd-<MEMBER_ID>.json"
```

### 1.3 Vérifier la signature HMAC

```bash
# Requis : RGPD_EXPORT_HMAC_SECRET (voir token-rotation.md §2.1)
RGPD_EXPORT_HMAC_SECRET=<secret> \
  node scripts/verify-rgpd-export.mjs export-rgpd-<MEMBER_ID>.json
# Attendu : "Signature valide" + exit 0
```

### 1.4 Envoyer à l'adhérent

1. Vérifier que la signature est valide (étape 1.3)
2. Envoyer le fichier `export-rgpd-<MEMBER_ID>.json` à l'adresse email de l'adhérent
3. Documenter la date d'envoi dans le canal #rgpd ou votre outil de ticketing
4. Archiver la demande (délai CNIL : conserver preuve 3 ans)

<!-- CAPTURE: docs/runbooks/screenshots/admin-rgpd/01-export-response.png -->

> **Délai CNIL** : La réponse doit parvenir à l'adhérent dans **1 mois** à compter de la réception de la demande (art. 12.3 RGPD). En cas de complexité, possibilité de prolonger de 2 mois supplémentaires en notifiant l'adhérent dans le premier mois.

---

## 2. Anonymisation adhérent (Story 7-6 — effacement FR63)

### 2.1 Pré-requis

- Vérifier l'identité de la demande (email de l'adhérent + confirmation écrite)
- Documenter la décision dans le canal #rgpd
- **ATTENTION** : L'anonymisation est **irréversible** (cross-tables : membres, SAV, audit_trail)

### 2.2 Exécuter l'anonymisation

```bash
# SESSION_COOKIE définie depuis §1.1 (cookie session navigateur)
curl -s -X POST \
  -H "Cookie: $SESSION_COOKIE" \
  -H "Content-Type: application/json" \
  https://sav.fruitstock.eu/api/admin/members/<MEMBER_ID>/anonymize \
  | jq .
# Attendu : { "anonymized": true, "member_id": <MEMBER_ID> }
```

### 2.3 Vérifier l'anonymisation

```bash
# SESSION_COOKIE définie depuis §1.1 (cookie session navigateur)
# Vérifier que les PII ont été effacées
curl -s \
  -H "Cookie: $SESSION_COOKIE" \
  https://sav.fruitstock.eu/api/admin/members/<MEMBER_ID>/rgpd-export \
  | jq '.member'
# Attendu : email = "[anonymized]", first_name = null, last_name = "[anonymized]"
```

### 2.4 Documenter

1. Consigner la date d'anonymisation, le motif et l'identifiant anonymisé dans le registre RGPD
2. Conserver la preuve de la demande (email) pendant 5 ans (prescriptions légales)

---

## 3. Consultation Audit Trail (Story 7-5)

### 3.1 Interface admin

1. Naviguer vers `https://sav.fruitstock.eu/admin/audit-trail`
2. Filtrer par :
   - **Type d'entité** : `members`, `credit_number_sequence`, etc.
   - **Action** : `anonymize`, `cutover_seed`, etc.
   - **Date** : plage de dates
3. Exporter si besoin via le bouton **Exporter CSV**

<!-- CAPTURE: docs/runbooks/screenshots/admin-rgpd/02-audit-trail.png -->

### 3.2 Durées de conservation de l'audit trail

| Données | Durée | Référence |
|---------|-------|-----------|
| Audit trail (actions) | 10 ans | NFR-D10 (DPIA §5) |
| PII dans `diff` | Purgés à l'anonymisation (W11) | Story 7-6 D-11 |
| magic-link tokens | 15 min | Story 1.5 |

---

## 4. Délais réglementaires CNIL

| Droit exercé | Délai CNIL | Référence |
|-------------|-----------|-----------|
| Portabilité (FR62) | 1 mois (+ 2 mois si complexe) | Art. 12.3 RGPD |
| Effacement (FR63) | 1 mois | Art. 12.3 RGPD |
| Accès | 1 mois | Art. 12.3 RGPD |
| Rectification | 1 mois | Art. 12.3 RGPD |

> **Obligation de notification** : Si dépassement du délai d'1 mois, notifier l'adhérent dans le premier mois.

---

## Si ça casse

### Export RGPD retourne 401 Unauthorized

- Vérifier que le cookie `session` est valide et non expiré (voir §1.1)
- La session expire ~7 jours après connexion — se reconnecter via magic-link pour obtenir un nouveau cookie

### Export RGPD retourne 404

- Vérifier que `<MEMBER_ID>` est correct (utiliser l'interface admin pour retrouver l'ID)
- Vérifier que le membre n'a pas déjà été anonymisé

### Signature HMAC invalide

- Vérifier que `RGPD_EXPORT_HMAC_SECRET` est le bon secret (voir [token-rotation.md](token-rotation.md) §2.1)
- Le fichier a peut-être été altéré — ne pas envoyer à l'adhérent
- Contacter le tech-lead immédiatement

### Anonymisation échoue

- Vérifier les droits admin
- Consulter les logs d'erreur via `/admin/audit-trail`
- Contacter le tech-lead si l'erreur persiste

---

**Dernière mise à jour** : 2026-05-01 — Story 7.7 V1
