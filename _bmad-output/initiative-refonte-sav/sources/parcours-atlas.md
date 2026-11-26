# Sources et couverture de la refonte

La couleur demandée par l’opérateur le 26 novembre 2026 est l’orange carotte de Fruitstock. Sa valeur actuelle est `#E88A23` dans [le thème](../../../client/src/styles/fruitstock-theme.css). L’atlas approuvé comme base de planification distingue les captures et les propositions. Les lignes, valeurs et nouvelles commandes fictives servent à comparer la présentation. Les comportements attendus viennent de l’application existante.

| Vue | Écran de l’atlas | Référence de l’existant | Story |
|---|---|---|---|
| `accueil` | [Retrouver ma facture](/Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#accueil) | Production en lecture seule | 1.1 |
| `facture` | [Articles de la facture](/Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#facture) | Interface locale et réponses simulées | 1.2 |
| `declaration` | [Signaler un problème](/Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#declaration) | Interface locale et réponses simulées | 1.2 |
| `panier` | [Relire ma demande](/Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#panier) | Interface locale et réponses simulées | 1.2 |
| `erreur` | [Envoi interrompu](/Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#erreur) | Interface locale et réponses simulées | 1.3 |
| `confirmation` | [Demande reçue](/Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#confirmation) | Interface locale et réponses simulées | 1.3 |
| `lien` | [Lien de connexion expiré](/Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#lien) | Interface locale et réponses simulées | 2.1 |
| `membre` | [Mes demandes](/Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#membre) | Interface locale et réponses simulées | 2.1 |
| `groupe` | [Demandes de mon groupe](/Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#groupe) | Interface locale et réponses simulées | 2.1 |
| `membre-detail` | [Suivre mon SAV](/Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#membre-detail) | Interface locale et réponses simulées | 2.2 |
| `preferences` | [Préférences de notifications](/Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#preferences) | Interface locale et réponses simulées | 2.3 |
| `login` | [Connexion opérateur](/Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#login) | Production en lecture seule | 3.1 |
| `liste` | [Liste des SAV](/Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#liste) | Production en lecture seule | 3.1 |
| `vide` | [Aucun résultat](/Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#vide) | Production en lecture seule | 3.1 |
| `brouillon` | [Dossier · Brouillon](/Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#brouillon) | Maquette uniquement | 3.2 |
| `recu` | [Dossier · Reçu](/Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#recu) | Production en lecture seule | 3.2 |
| `traitement` | [Dossier · En cours](/Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#traitement) | Production en lecture seule | 3.2 |
| `valide` | [Dossier · Validé](/Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#valide) | Production en lecture seule | 3.2 |
| `clos` | [Dossier · Clos](/Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#clos) | Maquette uniquement | 3.2 |
| `annule` | [Dossier · Annulé](/Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#annule) | Production en lecture seule | 3.2 |
| `edition` | [Éditer une ligne](/Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#edition) | Production en lecture seule | 4.1 |
| `pieces` | [Pièces et échanges](/Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#pieces) | Production en lecture seule | 4.2 |
| `preparation` | [Choisir le classeur](/Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#preparation) | Production en lecture seule | 5.1 |
| `import` | [Vérifier l’import](/Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#import) | Interface locale et réponses simulées | 5.1 |
| `arbitrage` | [Arbitrer les lignes](/Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#arbitrage) | Interface locale et réponses simulées | 5.2 |
| `exclusion` | [Ligne exclue](/Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#exclusion) | Interface locale et réponses simulées | 5.2 |
| `genere` | [Réclamation générée](/Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#genere) | Interface locale et réponses simulées | 5.3 |
| `historique` | [Versions fournisseur](/Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#historique) | Production en lecture seule | 5.3 |
| `regeneration` | [Confirmer un nouvel import](/Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#regeneration) | Interface locale et réponses simulées | 5.3 |
| `dashboard` | [Tableau de bord](/Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#dashboard) | Production en lecture seule | 6.1 |
| `exports` | [Historique des exports](/Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#exports) | Production en lecture seule | 6.2 |
| `erp` | [File ERP](/Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#erp) | Production en lecture seule | 6.2 |
| `maintenance` | [Maintenance](/Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#maintenance) | Production en lecture seule | 6.3 |
| `settings` | [Paramètres](/Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#settings) | Production en lecture seule | 7.1 |
| `audit` | [Journal d’audit](/Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#audit) | Production en lecture seule | 7.1 |
| `operators` | [Opérateurs](/Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#operators) | Production en lecture seule | 7.2 |
| `catalog` | [Catalogue produits](/Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#catalog) | Production en lecture seule | 7.3 |
| `validation` | [Listes de validation](/Users/antho/Dev/brain/projects/sav-mono-repo/app-improvements/output/atlas-sav/index.html#validation) | Production en lecture seule | 7.3 |
