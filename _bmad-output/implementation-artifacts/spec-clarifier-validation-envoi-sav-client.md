---
title: 'Clarifier la validation et l’envoi du SAV client'
type: 'bugfix'
created: '2026-06-19'
status: 'done'
baseline_commit: 'b69e43797b87df2314175d7b3fb258c7aef8f98b'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** La validation d’une ligne est une opération locale (`filled=true`) sans envoi serveur, mais son libellé et son retour de succès ressemblent à une validation définitive. Sur une facture longue, le bouton d’envoi global apparaît très loin sous la liste : le client peut quitter la page en croyant son SAV transmis.

**Approach:** Séparer clairement les verbes et les états : une ligne est « ajoutée à la demande », puis une barre d’action finale persistante permet d’« envoyer la demande SAV ». Ajouter un avertissement de sortie tant qu’une demande préparée n’a pas été envoyée.

## Boundaries & Constraints

**Always:** Conserver le payload, les validations métier, les uploads et l’appel `/api/webhooks/capture` actuels. Le succès définitif ne doit être annoncé qu’après la réponse positive du serveur. Employer un libellé final singulier, compréhensible même avec une seule ligne.

**Ask First:** Toute modification du comportement serveur, toute sauvegarde persistante d’un brouillon, ou tout envoi automatique après validation d’une ligne.

**Never:** Fusionner validation locale et envoi serveur, envoyer sans action finale explicite, ou dépendre uniquement d’un toast temporaire pour communiquer l’état.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|----------------|
| Ligne valide | Formulaire produit valide | Bouton « Ajouter à ma demande SAV » ; état inline « Ajoutée — pas encore envoyée » ; barre finale visible avec compteur | Les erreurs de champs restent inline et aucun brouillon n’est marqué ajouté |
| Demande prête | Une ou plusieurs lignes ajoutées, aucune ligne incomplète | Action persistante « Envoyer ma demande SAV (N réclamation[s]) » visible sans aller en bas de page | Pendant l’envoi, action désactivée et libellé de progression actuel conservé |
| Ligne incomplète | Au moins un formulaire ouvert non ajouté | Action finale visible mais désactivée avec explication « Finalisez ou annulez la ligne en cours » | Aucun modal d’upload ne s’ouvre |
| Sortie prématurée | Au moins une ligne ajoutée et demande non envoyée | Navigation/rechargement/fermeture déclenche un avertissement de perte | Aucun avertissement après succès serveur ou sans ligne ajoutée |

</frozen-after-approval>

## Code Map

- `client/src/features/sav/components/WebhookItemsList.vue` -- libellés, états inline, récapitulatif et action finale persistante ; orchestre l’envoi.
- `client/src/features/sav/composables/useSavForms.js` -- source de vérité des lignes ajoutées/incomplètes et compteur de réclamations.
- `client/src/features/sav/views/InvoiceDetails.vue` -- applique l’avertissement aux navigations internes Vue Router.
- `client/tests/unit/features/sav/components/WebhookItemsList.spec.js` -- couverture du rendu et des transitions UX.
- `client/tests/unit/features/sav/views/InvoiceDetails.spec.js` -- couverture des gardes de navigation interne.
- `client/tests/e2e/sav-happy-path.spec.js` -- preuve que le parcours renommé atteint toujours la confirmation serveur.

## Tasks & Acceptance

**Execution:**
- [x] `client/src/features/sav/composables/useSavForms.js` -- exposer le nombre de lignes ajoutées et un état de demande non envoyée sans changer la collecte des formulaires.
- [x] `client/src/features/sav/components/WebhookItemsList.vue` -- renommer l’action locale, remplacer le faux succès par un état inline explicite, rendre l’action finale persistante et gérer l’avertissement de sortie.
- [x] `client/src/features/sav/views/InvoiceDetails.vue` -- relayer la protection de sortie lors d’une navigation interne.
- [x] `client/tests/unit/features/sav/components/WebhookItemsList.spec.js` -- tester les libellés, compteur, état désactivé, avertissement de sortie et disparition de l’avertissement après soumission.
- [x] `client/tests/unit/features/sav/views/InvoiceDetails.spec.js` -- tester le relais des protections de navigation et son fallback.
- [x] `client/tests/e2e/sav-happy-path.spec.js` -- adapter le parcours aux nouveaux libellés et vérifier l’accès à la confirmation finale.

**Acceptance Criteria:**
- Given une facture contenant plusieurs produits, when le client ajoute une réclamation sur une ligne, then aucun message ne laisse entendre qu’elle a été envoyée et l’action finale est visible dans le viewport.
- Given une demande préparée, when le client tente de quitter avant l’envoi, then le navigateur l’avertit que la demande SAV n’a pas été envoyée.
- Given un envoi serveur réussi, when la confirmation s’affiche, then aucun avertissement de sortie ne subsiste.
- Given un écran mobile ou desktop, when la barre finale est affichée, then elle ne masque ni les champs actifs ni l’action « Retour ».

## Spec Change Log

## Design Notes

La hiérarchie recommandée repose sur deux verbes non ambigus :

- action de ligne, secondaire/orange : « Ajouter à ma demande SAV » ;
- état de ligne : « Ajoutée à votre demande — pas encore envoyée » ;
- action globale, primaire/verte et persistante : « Envoyer ma demande SAV (1 réclamation) ».

La barre persistante doit rester dans le flux sur grand écran et devenir `sticky` en bas du viewport pendant le défilement. Elle affiche le compteur et l’état bloquant éventuel. L’encart d’aide initial peut être raccourci en deux étapes numérotées, mais ne remplace pas les signaux contextuels.

## Verification

**Commands:**
- `cd client && npm test -- --run src/features/sav/components/WebhookItemsList.spec.js` -- les états UX et la soumission restent couverts.
- `cd client && npx playwright test tests/e2e/sav-happy-path.spec.js` -- le parcours complet atteint la confirmation.

**Manual checks (if no CLI):**
- Vérifier avec une facture de 8 lignes qu’après ajout de la première réclamation, l’action finale reste visible sans atteindre le bas de la liste.
- Vérifier les largeurs mobile et desktop, notamment le recouvrement du dernier contenu par la barre persistante.

## Suggested Review Order

**Hiérarchie des actions**

- Distingue clairement l’ajout local de l’envoi serveur définitif.
  [`WebhookItemsList.vue:448`](../../client/src/features/sav/components/WebhookItemsList.vue#L448)

- Maintient l’action finale, son compteur et ses états bloquants dans le viewport.
  [`WebhookItemsList.vue:481`](../../client/src/features/sav/components/WebhookItemsList.vue#L481)

- Simplifie l’aide initiale en deux étapes indépendantes de la couleur.
  [`WebhookItemsList.vue:188`](../../client/src/features/sav/components/WebhookItemsList.vue#L188)

**Protection contre la perte**

- Centralise les états ajouté, incomplet et réellement modifié.
  [`useSavForms.js:39`](../../client/src/features/sav/composables/useSavForms.js#L39)

- Protège fermeture et rechargement, puis réarme après une nouvelle préparation.
  [`WebhookItemsList.vue:571`](../../client/src/features/sav/components/WebhookItemsList.vue#L571)

- Relaye la confirmation sur départ et mise à jour de route.
  [`InvoiceDetails.vue:77`](../../client/src/features/sav/views/InvoiceDetails.vue#L77)

**Vérifications**

- Couvre le vrai ajout, les blocages et les protections avant/après succès.
  [`WebhookItemsList.spec.js:202`](../../client/tests/unit/features/sav/components/WebhookItemsList.spec.js#L202)

- Couvre les gardes Vue Router et leur fallback.
  [`InvoiceDetails.spec.js:4`](../../client/tests/unit/features/sav/views/InvoiceDetails.spec.js#L4)

- Conserve la preuve E2E du passage jusqu’à la confirmation serveur.
  [`sav-happy-path.spec.js:110`](../../client/tests/e2e/sav-happy-path.spec.js#L110)
