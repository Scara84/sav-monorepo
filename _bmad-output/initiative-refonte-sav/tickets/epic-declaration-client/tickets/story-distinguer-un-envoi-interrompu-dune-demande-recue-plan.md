---
title: Distinguer un envoi interrompu d’une demande reçue
type: feature
ticket: 3
created: 2026-11-26
status: built
baseline_revision: 'fe183dfb39335af1fceabfc6911efa277ccda6d1'
route: oneshot
route_source: pinned
risk: high
review: thorough
review_source: pinned
lenses_ran: [blind-hunter, edge-case-hunter, verification-gap, intent-alignment]
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: []
deferred:
  - summary: >-
      Une réponse perdue après création côté serveur peut donner lieu à un doublon lors d’une reprise manuelle.
    evidence: |-
      Chaque reprise utilise un nouveau jeton. Le contrat existant ne fournit pas de clé de dédoublonnage entre deux tentatives.
    location: >-
      client/src/features/sav/composables/useApiClient.js
    severity: high
---

<intent-contract>

## Intent

Deux activations rapprochées produisent une capture unique. Montrer l’attente, conserver les deux lignes et la photo après échec, permettre la correction et attendre le succès du service avant la confirmation. Réutiliser le panier, les styles carotte et le contrat existants. Afficher uniquement les informations de suivi réellement fournies.

</intent-contract>

## Implementation Notes

Route oneshot demandée pour cette story limitée au parcours de déclaration. Le risque métier impose de vérifier le nombre et le contenu des captures.

Le panier reste visible pendant la soumission. Le verrou est posé avant toute attente. La référence du reçu est transmise à la confirmation via l’historique de navigation. Les photos conservées sont réutilisées après un échec. Le retrait d’une photo déjà transférée renouvelle le dossier partagé.

## Plan Change Log

## Review Triage Log

### 2026-11-26 — Revue approfondie

15 constats, dont 2 élevés, 12 moyens et 1 mineur. Les observations convergentes sont détaillées par lecture.

- [high] [defer] Réponse perdue après création. Le contrat de capture existant ne dédoublonne pas deux reprises manuelles. Contrat conservé à la demande de l’opérateur.
- [medium] [patch] Une photo retirée après interruption pouvait rester visible via le lien de dossier. Nouveau dossier si la sélection exclut un fichier transféré.
- [medium] [patch] Attente de réception annoncée pendant la préparation. État de capture explicite et retrait du délai artificiel.
- [medium] [patch] Quatre attentes E2E obsolètes. Libellés et doublures actualisés.
- [medium] [patch] Référence, focus du titre et visite directe insuffisamment couverts. Assertions de navigation ajoutées.
- [high] [defer] Deuxième constat sur la perte de réponse après création. Même limite du service, hors garantie demandée pour deux clics rapprochés.
- [medium] [patch] Photo retirée encore accessible dans le dossier. Rotation du dossier et test de la sélection finale.
- [medium] [patch] Panier vidé conservant l’erreur précédente. Réinitialisation lorsque toutes les lignes et saisies sont retirées.
- [medium] [patch] HTTP 200 vide ou HTML pris pour un reçu. Validation du savId et tests de réponses malformées.
- [low] [patch] Nom du fichier courant inutilisé après retrait de la fenêtre. État supprimé.
- [medium] [patch] Ancienne attente de succès et doublure de capture périmée. Scénario de succès aligné sur le reçu, sa référence et le focus.
- [medium] [patch] Trois assertions d’échec périmées. Libellés et commande de reprise actualisés.
- [medium] [patch] Visite directe sans reçu non testée. Cas ajouté et observé dans le navigateur intégré.
- [medium] [patch] Transfert intermédiaire non testé. Deux photos avec la seconde suspendue, progression à 1 sur 2 et zéro capture avant sa résolution.
- [medium] [patch] La preuve unitaire seule ne couvre pas tout le scénario à deux articles. Recette rejouée après les corrections dans le navigateur intégré aux deux largeurs.

## Verification

Tester le composant, le contrat HTTP et les vues concernées. Dans le navigateur intégré, utiliser une facture fictive avec deux articles et une photo, simuler le téléversement et garder la capture en attente. Après deux clics vérifier une capture, faire échouer, comparer les deux lignes, corriger une quantité puis vérifier la seconde capture et ses identifiants. Libérer le succès, vérifier le message et revenir à l’accueil au clavier. Conserver les états envoi, erreur et confirmation sur ordinateur et à 390 px.


## Auto Run Result

- WebhookItemsList.vue protège la capture et conserve les lignes corrigibles. InvoiceDetails.vue transmet le reçu et SavConfirmation.vue affiche la référence délivrée par le service.
- useApiClient.js exige un identifiant de dossier valide. Les tests associés, les tests de composant et les deux scénarios E2E ont été actualisés.
- Depuis client, vitest run WebhookItemsList useSavForms InvoiceDetails useApiClient buildCaptureItemPrices. 137 tests réussis dans 7 suites.
- Recette finale dans le navigateur intégré avec le téléversement et la capture entièrement simulés. À 1160 et 390 px, une capture pour deux clics, puis une capture supplémentaire par reprise. Quatre appels au total sur les deux parcours finaux. Attente visible, confirmation absente pendant les deux attentes. Échec HTTP 503. Les lignes AV-41 et CI-82, leurs motifs, commentaires, unités et photo sont préservés. Après correction, 3 kg pour AV-41 et 2 pièces pour CI-82 dans le contenu reçu. Le succès affiche SAV-TEST-013. Focus clavier de 3 px sur la reprise et le retour, arrivée à l’accueil observée. Visite directe sans reçu redirigée.
- Six captures finales conservées dans le brain, app-improvements/output/recette-story-1-3. Les fichiers Playwright E2E ont été actualisés par inspection et la recette a été exécutée exclusivement dans le navigateur intégré.
- Les corrections moyennes ont été revérifiées par tests ciblés et recette. Le risque reporté de réponse perdue après création nécessite une évolution du contrat serveur, hors de cette story. Aucun autre passage de revue recommandé.
