# H-13 W72 — Runbook suppression scenarios Make (action user-required)

Status: pending-user-action
created: 2026-05-14
story: `_bmad-output/stories/h-13c-make-scenarios-deletion.md` AC#1-AC#3 (W72 découplé de h-13 vers h-13c via DN-7 2026-05-14 — nom historique du runbook conservé pour ne pas perturber git history)

---

## Contexte

Les 2 scenarios Make suivants sont en état `disabled` depuis le cutover Story 5.7 (2026-04-28).
La fenêtre de rollback de 30j est expirée à partir du 2026-05-28. Cette action est **irréversible**.

- **Scenario `3197846`** — lookup invoice v1 (historique `VITE_WEBHOOK_URL`)
- **Scenario `3203836`** — capture-SAV (historique `VITE_WEBHOOK_URL_DATA_SAV`)

**Pattern PATTERN-OPS-IRREVERSIBLE-PROOF** : preuve visuelle datée obligatoire (DN-4(a) tranché 2026-05-14).

---

## Pré-requis avant d'exécuter

- [ ] Story 5.7 stable en prod depuis >= 30j (cutover 2026-04-28 → plancher 2026-05-28)
- [ ] h-13 AC#2 W75 curl Pennylane exécuté et ne révèle pas de bug actif nécessitant un rollback Make (soft — pas un blocker dur pour h-13c, les scenarios disabled sont inertes)
- [ ] Accès admin UI Make.com compte Fruitstock disponible

> **STOP si l'un des pré-requis n'est pas rempli.** Ne pas supprimer les scenarios avant validation complète.

---

## Étapes

### Étape 1 — Screenshot AVANT deletion

1. Login Make.com → compte Fruitstock
2. Naviguer vers **Scenarios** (menu latéral gauche)
3. Filtrer ou chercher les scenarios par status `disabled` ou par ID (`3197846`, `3203836`)
4. S'assurer que les 2 IDs sont **visibles et en état `disabled`** à l'écran
5. Prendre un screenshot de la liste montrant les 2 scenarios présents

   Nommer le fichier : `.tmp-screenshots/h-13c-w72-make-listing-before-YYYY-MM-DD.png`
   (remplacer `YYYY-MM-DD` par la date du jour, ex. `2026-05-28`)

### Étape 2 — Pré-deletion verification (defense-in-depth)

Pour **chacun** des 2 scenarios (commencer par `3203836`, puis `3197846`) :

1. Ouvrir le scenario
2. Vérifier dans l'onglet **History** que la dernière exécution date de **>= 30j** (doit être antérieure au 2026-04-28)
3. Vérifier que le status badge affiche bien `disabled`
4. **Si le scenario tourne encore** (impossible logiquement post-cutover prod 2026-04-28, mais vérification defense-in-depth) → **STOP, NE PAS SUPPRIMER, investiguer pourquoi**

### Étape 3 — Suppression scenario `3203836`

1. Ouvrir le scenario `3203836`
2. Cliquer sur le menu `...` (top-right, 3 points)
3. Sélectionner **Delete scenario**
4. Confirmer la modale de suppression
5. Vérifier que le scenario disparaît de la liste

### Étape 4 — Suppression scenario `3197846`

1. Même procédure que l'étape 3 pour `3197846`
2. Confirmer la modale de suppression
3. Vérifier que le scenario disparaît de la liste

### Étape 5 — Screenshot APRÈS deletion

1. Revenir à la liste complète des scenarios Make (compte Fruitstock)
2. Vérifier que les IDs `3197846` et `3203836` sont **absents** (preuve par exclusion)
3. Prendre un screenshot de la liste complète post-deletion

   Nommer le fichier : `.tmp-screenshots/h-13c-w72-make-listing-after-YYYY-MM-DD.png`
   (même date que le screenshot AVANT)

---

## Rapport au pipeline

Une fois les étapes exécutées, reporter au pipeline :

- Chemin du screenshot AVANT : `.tmp-screenshots/h-13c-w72-make-listing-before-YYYY-MM-DD.png`
- Chemin du screenshot APRÈS : `.tmp-screenshots/h-13c-w72-make-listing-after-YYYY-MM-DD.png`
- Confirmation que les 2 scenarios `3197846` et `3203836` sont supprimés

Le pipeline peut alors :
- Mettre à jour `_bmad-output/implementation-artifacts/deferred-work.md` ligne 221 (W72 strikethrough)
- Progresser vers h-13c AC#4 clôture (W72 découplé de h-13 → h-13c via DN-7 2026-05-14 ; ce runbook est désormais consommé par h-13c, nom historique h-13 conservé pour ne pas perturber git history)

---

## Notes de sécurité

- **Action irréversible** : une fois supprimés, les scenarios ne peuvent pas être restaurés sans recréer from scratch
- Aucun blueprint JSON archivé en repo V1 — la suppression est définitive
- Rationalité : surface d'attaque réduite (si compte Make compromis, scenario ne peut plus être ré-activé)
- Coût implicite Make ~9€/mois/scenario (plan Pro, même disabled) → économie ~18€/mois post-suppression
