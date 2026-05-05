# Runbook — Cutover J+0 (Bascule Production V1)

> **Audience** : Tech-lead Fruitstock (Antho)
> **Objectif** : Orchestrer la bascule complète Google Sheet → SAV prod V1 (seed séquence avoir, DNS, smoke-test GO/NO-GO)
> **Prérequis** : Accès Supabase prod, accès Vercel dashboard, accès DNS registrar, canal #cutover Slack actif

---

## TL;DR

1. **J-7** : vérifier prérequis, DPA signés, branch protection activée
2. **J-1** : dry-run export xlsm, vérifier rollback testé
3. **J+0 08h00** : gel Google Sheet → seed-sequence → DNS → smoke-test → GO/NO-GO
4. **En cas de NO-GO** : rollback immédiat (voir [rollback.md](rollback.md))

> **Référence Make→Pennylane/SMTP** : voir aussi [`docs/cutover-make-runbook.md`](../cutover-make-runbook.md) (Story 5-7) pour la portion spécifique Make.com.

---

## §0 — Configuration post-merge (action manuelle Antho)

Ces actions sont à effectuer **une seule fois, immédiatement après merge de la story 7-7** dans `main`.

### 0.1 Branch protection rule GitHub

1. Aller sur `https://github.com/<org>/sav-monorepo/settings/branches`
2. Ajouter/modifier la règle pour la branche `main` :
   - ✅ Require status checks to pass before merging
   - Ajouter le check : `dpia-gate`
   - ✅ Require branches to be up to date before merging
3. Sauvegarder

### 0.2 Signature DPIA

1. Ouvrir `docs/dpia/v1.md`
2. Compléter la section `## Signature` :
   - `**Date** : <date ISO 8601 du jour>`
   - `**Responsable** : Antho Scaravella, Tech-Lead / DPO Fruitstock`
   - `**Signature** : <mention explicite d'approbation>`
3. Committer et pousser

### 0.3 Vérifier le CI gate DPIA

```bash
npm run verify:dpia
# Attendu : exit 0 + "DPIA OK — signature valide"
```

---

## §1 — J-7 Prérequis

### Checklist J-7

- [ ] Tous les DPA fournisseurs signés (Supabase, Vercel, Microsoft 365, Pennylane, Infomaniak, Make.com)
- [ ] `docs/dpia/v1.md` signé et `verify:dpia` → exit 0
- [ ] Branch protection `dpia-gate` configurée (§0.1)
- [ ] Accès Supabase prod confirmé (connexion psql test)
- [ ] Accès Vercel dashboard confirmé
- [ ] Accès DNS registrar confirmé
- [ ] Canal Slack #cutover créé, équipe invitée
- [ ] Dry-run `seed-credit-sequence.sql` sur DB staging OK
- [ ] Export xlsm staging OK (voir §2)
- [ ] Mailtrap.io configuré (SMTP_SAV_HOST de remplacement pour smoke-test)

---

## §2 — J-1 Dry-run rollback

### 2.1 Export xlsm (dry-run)

```bash
cd client
SUPABASE_URL=<PROD_URL> SUPABASE_SERVICE_ROLE_KEY=<PROD_KEY> \
ROLLBACK_OUT_DIR=./rollback-output/J-1-dryrun \
npx tsx scripts/rollback/export-to-xlsm.ts
```

Résultat attendu :
- 9 fichiers `.xlsm` dans `rollback-output/J-1-dryrun/`
- `dryrun-<ISO>.json` avec SHA-256 par fichier
- 0 LARGE_TABLE warning (ou documenté si présent)

### 2.2 Archiver l'export

```bash
# Archiver dans GCS ou autre stockage sécurisé
tar czf rollback-J-1-$(date +%Y%m%d).tar.gz rollback-output/J-1-dryrun/
# Uploader en lieu sûr accessible hors-prod
```

### 2.3 Vérifier le rollback procédure

Simuler mentalement les 3 cas de rollback (voir [rollback.md](rollback.md) §2).

---

## §3 — J+0 Séquence minute-par-minute

### 3.1 08h00 — Gel Google Sheet

- [ ] Ouvrir le Google Sheet legacy `SAV_Admin`
- [ ] Aller dans **Données → Protéger les feuilles et les plages**
- [ ] Protéger tous les onglets en écriture (seul le tech-lead peut modifier)
- [ ] Annoncer le gel dans #cutover : `"Google Sheet gelé à 08h00"`
- [ ] **Relever le dernier numéro d'avoir** dans l'onglet `Avoirs` (dernière ligne, colonne `Numéro`)

<!-- CAPTURE: docs/runbooks/screenshots/operator-daily/03-google-sheet-gel.png -->

### 3.2 08h15 — Seed credit_number_sequence (AC #1)

```bash
# Remplacer 4567 par le numéro relevé à l'étape 3.1
export LAST_CREDIT_NUMBER=4567
export SUPABASE_DB_URL="<URL_PSQL_PROD>"

# VÉRIFICATION DRY-RUN (lecture seule)
psql "$SUPABASE_DB_URL" -c \
  "SELECT last_number FROM credit_number_sequence WHERE id = 1;"
# Attendu : last_number = 0 (état initial)

# EXÉCUTION PROD (UNE SEULE FOIS)
cd client
LAST_CREDIT_NUMBER=$LAST_CREDIT_NUMBER psql "$SUPABASE_DB_URL" \
  -v last_credit_number="$LAST_CREDIT_NUMBER" \
  -v cutover_operator="$USER" \
  -f scripts/cutover/seed-credit-sequence.sql
```

#### Checklist 3.2

- [ ] `[ ] Google Sheet figé (Fichier → Protéger la feuille)`
- [ ] `[ ] LAST_CREDIT_NUMBER copié : _______`
- [ ] `[ ] Dry-run preview Supabase OK (last_number = 0 confirmé)`
- [ ] `[ ] Exécution prod : SEEDED OK`
- [ ] `[ ] Audit row vérifiée` : `psql "$SUPABASE_DB_URL" -c "SELECT * FROM audit_trail WHERE action='cutover_seed' ORDER BY created_at DESC LIMIT 1;"`
- [ ] `[ ] Valeur finale loguée dans #cutover Slack`

### 3.3 08h30 — Bascule DNS

1. Aller sur le DNS registrar
2. Modifier l'entrée `sav.fruitstock.eu` → pointer vers Vercel
3. TTL = 300s (5 minutes) pour rollback rapide si nécessaire
4. Annoncer dans #cutover : `"DNS basculé à 08h30"`
5. Vérifier propagation : `dig sav.fruitstock.eu` (attendre ~5 min)

### 3.4 08h45 — Smoke-test (SMTP mailtrap activé)

#### AVANT le smoke-test : activer SMTP mailtrap (D-10)

1. Dashboard Vercel → `sav.fruitstock.eu` → Settings → Environment Variables
2. Modifier `SMTP_SAV_HOST` → `smtp.mailtrap.io` (valeur temporaire)
3. Modifier `SMTP_SAV_PORT` → port mailtrap (ex. 587)
4. Modifier `SMTP_SAV_USER` / `SMTP_SAV_PASSWORD` → credentials mailtrap
5. Confirmer le redéploiement si nécessaire

```bash
cd client
SUPABASE_URL=<PROD_URL> SUPABASE_SERVICE_ROLE_KEY=<PROD_KEY> \
SMOKE_MEMBER_EMAIL=cutover-smoke@fruitstock.invalid \
SMTP_SAV_HOST=smtp.mailtrap.io ONEDRIVE_OFFLINE=1 \
LAST_CREDIT_NUMBER=$LAST_CREDIT_NUMBER \
npx tsx scripts/cutover/smoke-test.ts
```

Résultat attendu :
- `scripts/cutover/results/smoke-J0-<ISO>.json` créé
- `verdict: "GO"` ou `verdict: "NO-GO"` avec `no_go_reason`
- `credit_number_emitted: <LAST+1>` (ex. 4568)

#### APRÈS le smoke-test : restaurer SMTP prod

1. Dashboard Vercel → remettre les vraies valeurs SMTP prod
2. Redéployer si nécessaire
3. Annoncer dans #cutover

### 3.5 08h50 — Vérifications post-smoke (OBLIGATOIRE)

#### Tripwire SMTP — vérifier que les credentials prod sont restaurés

> ⚠️ Si oublié : prod reste sur mailtrap → silent email loss durant 1+ jour.

- [ ] Vérifier `SMTP_SAV_HOST` dans Vercel env != `smtp.mailtrap.io` avant de quitter la console Vercel
- [ ] Logger la valeur `SHA8(SMTP_SAV_HOST)` dans le canal #cutover Slack pour traçabilité :

```bash
# Calculer SHA8 du host SMTP prod (à exécuter localement après récupération de la valeur)
echo -n "<SMTP_SAV_HOST_PROD>" | sha256sum | cut -c1-8
# Annoncer dans #cutover : "SMTP_SAV_HOST restauré — SHA8=<hash>"
```

- [ ] Redéploiement Vercel effectué avec les vraies valeurs SMTP prod

### 3.6 09h00 — GO/NO-GO

#### Si GO

- [ ] Annoncer dans #cutover : `"SMOKE-TEST GO — SAV prod V1 opérationnel"`
- [ ] Notifier les opérateurs que l'application est disponible
- [ ] Archiver le rapport smoke : `cat scripts/cutover/results/smoke-J0-<ISO>.json`
- [ ] Envoyer le rapport dans #cutover
- [ ] Confirmer tripwire SMTP OK (§3.5)

#### Si NO-GO

- [ ] Annoncer dans #cutover : `"SMOKE-TEST NO-GO — reason=<step> — rollback initié"`
- [ ] Exécuter le rollback immédiatement (voir [rollback.md](rollback.md))
- [ ] Débloquer le Google Sheet (retirer la protection)
- [ ] Investiguer la cause du NO-GO

---

## Si ça casse

### Le seed-sequence lève DRIFT_DETECTED

- NE PAS forcer l'exécution
- Lire l'erreur : `current=X requested=Y`
- Si `X` est correct (dernier avoir legacy) et `Y` est incorrect → corriger `LAST_CREDIT_NUMBER`
- Si `X > 0` et inattendu → rollback PITR (voir [rollback.md](rollback.md) §2.1)

### Le DNS ne propage pas

- Vérifier TTL avec `dig +ttl sav.fruitstock.eu`
- Attendre 10-15 min (cache DNS intermédiaires)
- Si > 30 min : contacter le registrar

### Le smoke-test échoue (NO-GO)

Voir [rollback.md](rollback.md) §3 — arbre de décision selon l'étape en échec.

### Problème SMTP après smoke-test

- Vérifier que les variables SMTP prod ont été restaurées sur Vercel
- Consulter [incident-response.md](incident-response.md) §4

---

**Dernière mise à jour** : 2026-05-01 — Story 7.7 V1
