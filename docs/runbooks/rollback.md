# Runbook — Rollback (Retour arrière)

> **Audience** : Tech-lead Fruitstock (Antho)
> **Objectif** : Orchestrer le retour arrière complet en cas d'échec prod : 3 cas possibles (PITR Supabase, xlsm fallback, DB totale)
> **Prérequis** : Export xlsm J-1 archivé, accès Supabase dashboard, accès Google Sheet admin, accès DNS registrar

---

## TL;DR

**Arbre de décision rollback (D-9)** :

```
NO-GO smoke / incident grave
├── ≤ 7 jours post-cutover : PITR Supabase (recommandé) → §2.1
├── > 7 jours ou PITR indisponible : xlsm fallback → §2.2
└── Défaillance totale DB / chiffrement : escalation Supabase support → §2.3
```

**RTO/RPO** :
- PITR : RPO ≤ 5 min, RTO ~1h (Supabase restore)
- xlsm fallback : RPO = J-1 export, RTO ~4h (reconstruction manuelle)
- Défaillance totale : RPO/RTO à définir avec Supabase support

---

## §1 — Décision de rollback

### 1.1 Critères de déclenchement

| Critère | Action |
|---------|--------|
| Smoke-test NO-GO (J+0) | Rollback immédiat |
| Incident P1 (perte de données) | Rollback PITR immédiat |
| Corruption DB (≤ 7j) | Rollback PITR |
| Corruption DB (> 7j) | xlsm fallback ou escalation |
| Indisponibilité totale | Escalation Supabase support |

### 1.2 Avant tout rollback

- [ ] Annoncer dans #cutover / #incident : `"ROLLBACK INITIÉ à <heure>"`
- [ ] Prendre une capture des erreurs observées
- [ ] Identifier le moment exact du problème (pour PITR : point de restauration cible)
- [ ] Si J+0 : s'assurer que le Google Sheet legacy est toujours gelé (NE PAS remettre en écriture avant rollback complet)

---

## §2 — Procédures de rollback

### 2.1 Rollback PITR Supabase (cas principal, ≤ 7 jours)

**Prérequis** : Plan Supabase Pro ou supérieur avec PITR activé.

```bash
# 1. Connexion Supabase Dashboard
# https://app.supabase.com/project/<project-ref>/database/backups/pitr

# 2. Sélectionner le point de restauration cible
#    Recommandé : 5 minutes avant l'incident détecté

# 3. Lancer la restauration (interface graphique)
#    Attention : la restauration remplace TOUTES les données
#    Durée estimée : 30-60 min selon taille DB
```

Checklist PITR :

- [ ] Point de restauration identifié (timestamp exact)
- [ ] Confirmation de la restauration via Supabase dashboard
- [ ] DB restaurée confirmée : `psql "$SUPABASE_DB_URL" -c "SELECT NOW(), count(*) FROM members;"`
- [ ] DNS remis sur Google Sheet / ancien système si nécessaire
- [ ] Google Sheet déprotégé
- [ ] Annonce dans #cutover

### 2.2 Rollback xlsm fallback (J-1 export)

Utilisé quand le PITR est indisponible ou si rollback > 7 jours.

#### 2.2.1 Récupérer l'export J-1

```bash
# Extraire l'archive J-1 (stockée sur GCS ou autre)
tar xzf rollback-J-1-<date>.tar.gz
ls rollback-output/J-1-dryrun/
# Attendu : 9 fichiers .xlsm + dryrun-<ISO>.json
```

#### 2.2.2 Restaurer les 4 référentiels (copy-paste direct SAV_Admin.xlsm)

Ces 4 fichiers peuvent être copiés-collés directement dans les onglets correspondants du `SAV_Admin.xlsm` legacy :

| Fichier xlsm | Onglet SAV_Admin.xlsm | Action |
|--------------|----------------------|--------|
| `members.xlsm` (onglet CLIENTS) | CLIENTS | Copy-paste données (sans en-tête si déjà présent) |
| `products.xlsm` (onglet BDD) | BDD | Copy-paste données |
| `groups.xlsm` (onglet GROUPES) | GROUPES | Copy-paste données |
| `validation_lists.xlsm` (onglet LISTE) | LISTE | Copy-paste données |

**Procédure copy-paste** :
1. Ouvrir `members.xlsm` dans Excel
2. Sélectionner toutes les données (Ctrl+A, exclure l'en-tête)
3. Copier (Ctrl+C)
4. Ouvrir `SAV_Admin.xlsm` → onglet CLIENTS
5. Sélectionner la première cellule de données (A2)
6. Coller les valeurs uniquement (Ctrl+Shift+V → Valeurs)
7. Vérifier le nombre de lignes

#### 2.2.3 Restaurer les 5 tables transactionnelles

Ces tables ne peuvent pas être copiées directement dans `SAV_Admin.xlsm` (format technique différent). Deux options :

**Option A** — Reconstruction Google Sheet externe :
1. Créer un nouveau Google Sheet `SAV-Transactions-Rollback`
2. Importer chaque fichier xlsm comme onglet séparé
3. Les données sont consultables mais non intégrées dans le legacy workflow

**Option B** — Conserver pour audit uniquement :
- Archiver les 5 fichiers xlsm transactionnels sur GCS
- Le legacy workflow repart de zéro sur les SAV (pertes de données entre J-1 et rollback — documentées)

> **Décision V1** : Option B recommandée pour simplifier le rollback. Les données transactionnelles depuis J-1 sont perdues — documentées dans le registre d'incidents.

### 2.3 Rollback défaillance totale DB

1. **Contacter Supabase support** immédiatement : `https://supabase.com/dashboard/support`
2. Fournir :
   - Project ref
   - Timestamp de l'incident
   - Description de la défaillance
   - Niveau d'urgence : P1 (production down)
3. En attendant : basculer le DNS vers une page de maintenance
4. Suivre les instructions Supabase support

---

## §3 — Arbre décisionnel détaillé

```
Incident détecté
│
├── J+0 smoke-test NO-GO ?
│   ├── Oui → Rollback PITR immédiat (§2.1)
│   │          DNS: remettre vers ancienne cible
│   │          Google Sheet: déprotéger
│   └── Non → Continuer l'analyse
│
├── Corruption / perte données ?
│   ├── ≤ 7 jours → PITR Supabase (§2.1)
│   ├── > 7 jours → xlsm fallback (§2.2)
│   └── Défaillance totale → Escalation §2.3
│
└── Incident applicatif (pas de perte données) ?
    → Rollback git + redéploiement Vercel
      git revert <commit>
      git push origin main
```

---

## §4 — Post-rollback

### Checklist post-rollback

- [ ] DB restaurée confirmée (requête de vérification)
- [ ] DNS remis sur ancienne cible (ou page maintenance)
- [ ] Google Sheet déprotégé et accessible
- [ ] Opérateurs notifiés du rollback et de la situation
- [ ] Incident documenté dans le registre
- [ ] Post-mortem planifié dans les 48h (voir [incident-response.md](incident-response.md) §5)

---

## Si ça casse

### PITR non disponible dans le dashboard Supabase

- Vérifier le plan Supabase (PITR = Pro plan requis)
- Vérifier que la fenêtre PITR (7 jours) n'est pas dépassée
- Si non disponible → xlsm fallback (§2.2)

### Fichiers xlsm J-1 corrompus ou introuvables

- Vérifier l'archive GCS
- Si introuvables → escalation Supabase support (§2.3) pour backup alternatif
- Documenter les données perdues dans le registre RGPD

### DNS ne revient pas vers l'ancienne cible

- Vérifier les TTL (propagation ~5-15 min)
- Contacter le registrar si > 30 min

---

**Dernière mise à jour** : 2026-05-01 — Story 7.7 V1
