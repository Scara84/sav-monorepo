# H-13 W75 — Runbook curl Pennylane v2 prod (action user-required)

Status: pending-user-action
created: 2026-05-14
story: `_bmad-output/stories/h-13-checklist-j30.md` AC#3
validation-template: `_bmad-output/implementation-artifacts/h-13-w75-pennylane-shape-validation.md`

---

## Contexte

Validation empirique en prod read-only (DN-2(b) tranché 2026-05-14) de la shape réelle
de l'API Pennylane v2. Objectifs par priorité décroissante :

1. **P1** — Confirmer que l'encoding `%3A` du filtre est préservé (breaking change UAT 2026-05-03).
2. **P2** — Confirmer la présence de `customer.emails: string[]` (direct list ou via `fetchCustomer()`).
3. **P3** — Confirmer shape root `items` vs `data` (faux positif probable — 16j prod stables).

**DN-2(b)** : prod read-only seul — pas de sandbox disponible. GET uniquement, aucune mutation prod.

---

## Pré-requis

- [ ] Accès UI Vercel → projet Fruitstock → Environment Variables → `PENNYLANE_API_KEY` (production)
- [ ] Un numéro de facture réel non-PII disponible (ex. `F-2025-XXXXX` d'un SAV récent — ne pas noter l'email client associé)
- [ ] Shell bash ou zsh interactif (pour `read -s` silent)
- [ ] `curl`, `node`, `jq` disponibles (`which curl node jq`)

---

## Procédure curl (pattern bash safe anti-exposure)

```bash
# 1. Récupérer PENNYLANE_API_KEY depuis Vercel UI (onglet Environment Variables → Production)
#    NE PAS copier-coller la clé dans un fichier texte ou dans l'historique shell.
#    Utiliser le prompt SILENT (-s) : rien n'apparaît à l'écran, rien dans bash_history.
read -s PENNYLANE_KEY
# (coller la valeur de PENNYLANE_API_KEY depuis Vercel UI, puis taper Entrée)

# 2. Définir un numéro de facture réel existant en prod
#    Remplacer F-2025-XXXXX par un numéro pré-vérifié (voir l'interface back-office SAV)
INV="F-2025-XXXXX"

# 3. Encoder le filtre JSON-array URL-encodé (même logique que encodePennylaneFilter() dans pennylane.ts)
FILTER='[{"field":"invoice_number","operator":"eq","value":"'"$INV"'"}]'
FILTER_ENC=$(node -e "console.log(encodeURIComponent(process.argv[1]))" "$FILTER")

# 4. Afficher l'URL effective pour vérification P1 (encoding %3A)
echo "URL effective : https://app.pennylane.com/api/external/v2/customer_invoices?filter=${FILTER_ENC}&limit=1"
# Vérifier que ':' dans {"field":"invoice_number"} apparaît bien comme %3A dans l'URL affichée

# 5. Exécuter le curl (GET read-only — aucune mutation prod)
#    -sS : silent + show errors | -w : afficher HTTP code | tee : sauvegarder hors repo
curl -sS -w "\nHTTP %{http_code}\n" \
  "https://app.pennylane.com/api/external/v2/customer_invoices?filter=${FILTER_ENC}&limit=1" \
  -H "Authorization: Bearer ${PENNYLANE_KEY}" \
  -H "Accept: application/json" \
  | tee /tmp/h-13-w75-pennylane-shape.json

# 6. Cleanup secret immédiat — NE PAS oublier
unset PENNYLANE_KEY

# 7. Purge de l'historique shell (bash)
history -d $((HISTCMD-1))
# Note zsh : `history -d` n'existe pas en zsh interactif. Alternatives :
#   - Préfixer la commande curl par un espace (si HISTCONTROL=ignorespace configuré)
#   - Éditer ~/.zsh_history manuellement après la session
#   - Utiliser `fc -W && fc -P` pour forcer flush + purge
```

---

## Analyse de la réponse (avec jq)

```bash
# Analyser le fichier sauvegardé (hors repo, sans clé API)
# P3 — Shape root : doit afficher "items" (attendu)
jq 'keys' /tmp/h-13-w75-pennylane-shape.json

# P3 — Contenu items[0]
jq '.items[0] | keys' /tmp/h-13-w75-pennylane-shape.json

# P2 — customer.emails
jq '.items[0].customer.emails' /tmp/h-13-w75-pennylane-shape.json

# P3 — Pagination keys
jq '{has_more: .has_more, next_cursor: .next_cursor}' /tmp/h-13-w75-pennylane-shape.json

# Shape invoice_lines (v2 sub-resource attendu)
jq '.items[0].invoice_lines' /tmp/h-13-w75-pennylane-shape.json
```

---

## Checklist post-curl

- [ ] HTTP code noté (attendu : 200)
- [ ] P1 encoding `%3A` vérifié sur l'URL effective affichée à l'étape 4
- [ ] P2 présence/absence `customer.emails` documentée
- [ ] P3 shape root (`items` ou `data`) documentée
- [ ] `unset PENNYLANE_KEY` exécuté
- [ ] Historique shell purgé (bash: `history -d` / zsh: voir note ci-dessus)
- [ ] `/tmp/h-13-w75-pennylane-shape.json` NON commité (hors repo, `/tmp/` uniquement)

---

## Remplir le template de validation

Après avoir analysé la réponse, remplir les sections de :
`_bmad-output/implementation-artifacts/h-13-w75-pennylane-shape-validation.md`

**Redaction obligatoire** : ne pas inclure d'emails client, de montants, de noms.
Paraphraser les observations (ex. "customer.emails: ['<redacted>'] présent" → "customer.emails présent, non-vide").

**Vérification pre-commit** (obligatoire avant `git add`) :

```bash
grep -E 'Bearer [A-Za-z0-9._-]{20,}|PENNYLANE_API_KEY\s*=\s*\S+|eyJ[A-Za-z0-9_-]{20,}|sb_(secret|publishable)_' \
  _bmad-output/implementation-artifacts/h-13-w75-pennylane-shape-validation.md
# Résultat attendu : 0 hit
```

---

## Décision post-validation (règle DN-3)

Après avoir rempli le template de validation, appliquer la règle DN-3 :

| Cas | Action |
|-----|--------|
| Shape matche code actuel (items + has_more + next_cursor + customer.emails OK) | Validation passive OK — 0 patch. Documenter "code matche shape" dans le template. |
| Divergence < 30 lignes prod ET 1 seul fichier (`pennylane.ts`) | Patch in-story H-13 AC#3(e). Commit séparé `fix(h-13-w75): patch PennylaneListResponse shape`. |
| Divergence >= 30 lignes OU > 1 fichier prod | Créer story `h-15-pennylane-shape-fix` (backlog). Clore AC#3 avec note "patch suivi dans h-15". |

**Si ship-blocker détecté** (P1 encoding 400, P2 customer.emails totalement absent, P3 data au lieu de items) :
signaler immédiatement au PM avant de continuer W72. Le fix W75 passe en priorité sur W72.
