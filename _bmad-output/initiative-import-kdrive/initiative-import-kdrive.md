---
type: initiative
title: "Importer le data.xlsx de la commande dans la demande fournisseur"
sources: ["_bmad-output/initiative-import-kdrive/sources/brief.md"]
companions: ["_bmad-output/initiative-import-kdrive/sources/infomaniak-kdrive-api.md"]
risk: high
---

# Importer le data.xlsx de la commande dans la demande fournisseur

## Outcome

L’opérateur ouvre une demande autorisée et obtient le même aperçu qu’avec l’import manuel, à partir du classeur de sa commande.

## Requirements

R1 (AC-01) — avec une configuration valide, un contrôle en lecture seule identifie le bon drive, résout le chemin de départ et vérifie qu'il est accessible ; une validation réelle complète comprend le téléchargement d'un fichier de test autorisé.

R2 (AC-02) — un token absent, invalide, expiré, un identifiant de drive erroné ou des droits insuffisants entraîne une erreur distincte et exploitable ; aucun secret n'est affiché ni journalisé.

R3 (AC-03) — les tests de connexion sont exécutables indépendamment du traitement fournisseur et ne modifient aucune donnée kDrive. Le succès de la connexion au drive seul n'est pas confondu avec le droit de télécharger dans le dossier cible.

R4 (AC-04) — les exemples valides de F-02 du brief retournent exactement les clés indiquées, sans altération du reste de la référence.

R5 (AC-05) — une valeur invalide ne déclenche aucune requête kDrive ni aucun traitement Excel.

R6 (AC-06) — la valeur provient de la demande fournisseur en cours, pas d'une donnée résiduelle provenant d'une autre demande.

R7 (AC-07) — avec une fixture reproduisant le chemin réel et la valeur illustrative `46_26S5_94_1`, la clé est `46_26S5_94`, la branche est `2026/S05` et le dossier unique trouvé est `fact_46_26S5_94_RUNGIS`. Avec `529_26S46_81_1`, la branche est `2026/S46` et la clé est `529_26S46_81`, indépendamment du nom complet du dossier. Vérifier parent, type et ascendance.

R8 (AC-08) — les correspondances valides du tableau F-03 du brief sont détectées comme candidats ; les faux positifs numériques, temporels, les fichiers portant ces noms, les dossiers hors branche et les dossiers à une profondeur incorrecte sont exclus. Tester la conversion `S5` et `S05` vers le dossier `S05` sans altérer la clé d'origine, les semaines 1–53 et les changements d'année. Ne pas traiter les archives/copies dont l'éligibilité n'est pas établie.

R9 (AC-09) — année, semaine ou dossier absent, plusieurs correspondances (même si une seule contient `data.xlsx`), statut actif incertain, convention non résolue, pagination incomplète ou ascendance non vérifiable bloque l'import avec un diagnostic précis. Ne jamais choisir le premier résultat ni substituer un homonyme d'une autre branche.

R10 (AC-10) — toutes les pages pertinentes du dossier semaine sont examinées ou l'opération échoue explicitement. Aucune recherche globale ni balayage récursif de l'ensemble de kDrive n'est nécessaire en fonctionnement normal. Les éventuels diagnostics ciblés ne déclenchent pas d'import avant confirmation de la branche et de l'unicité.

R11 (AC-11) — le fichier exact `data.xlsx` du bon dossier est récupéré via son identifiant, sous forme d'octets binaires originaux.

R12 (AC-12) — si `data.xlsx` n'existe pas, n'est pas un fichier ou ne peut pas être identifié de façon unique, aucune substitution et aucun traitement ne sont réalisés.

R13 (AC-13) — le backend refuse tout fichier dont le parent, le périmètre ou l'autorisation ne peuvent pas être vérifiés, y compris si le fichier a été déplacé entre la recherche et le téléchargement.

R14 (AC-14) — une réponse HTTP en échec, une réponse d'erreur JSON/HTML déguisée, un fichier vide, un transfert interrompu, un fichier corrompu ou trop volumineux pour les limites de l'import existant ne déclenche aucun traitement métier. Vérifier le véritable format XLSX via le parseur/validateur existant, pas seulement le nom ou le MIME ; prendre en compte le fait qu'un XLSX est une archive ZIP. Ne pas exiger un MIME précis si le fournisseur retourne un type binaire générique valide.

R15 (AC-15) — avec le même fichier et les mêmes données de demande, l'import automatique produit le même résultat métier que l'import manuel de référence.

R16 (AC-16) — le fichier est associé à la demande et à la valeur `Commande groupe` qui ont lancé l'opération. Un changement de commande pendant une récupération empêche le résultat obsolète de remplacer ou traiter les données de la nouvelle demande.

R17 (AC-17) — un double déclenchement concurrent ou une nouvelle tentative après erreur ne provoque ni double traitement ni écrasement silencieux d'un fichier déjà validé. Réutiliser les protections d'idempotence existantes ou en prévoir une au niveau de l'opération, en respectant les règles existantes de retraitement volontaire.

R18 (AC-18) — afficher un succès seulement si le traitement/import existant a accepté le fichier ; en cas d'échec, ne pas marquer la demande comme traitée, conserver l'intégrité de ses données et nettoyer les fichiers temporaires.

R19 (AC-19) — si l'import manuel est déjà disponible, il continue de fonctionner et respecte les règles existantes de validation/remplacement. Une erreur automatique n'injecte pas de fichier obsolète.

R20 (AC-20) — pendant l'opération, l'utilisateur voit un état de chargement et ne peut pas déclencher plusieurs imports concurrents pour la même demande.

R21 (AC-21) — les erreurs ne sont pas confondues avec un succès ; après une erreur récupérable, une tentative explicite est possible sans créer de doublon.

R22 (AC-22) — les messages et états sont lisibles, accessibles au clavier/lecteur d'écran selon les conventions UI existantes, et n'exposent ni bearer token, ni URL signée, ni contenu Excel sensible.

## Constraints

REST en lecture seule côté serveur. Conserver l’import manuel, l’arbitrage et la génération existants. Le sélecteur générique décrit dans la référence API est hors périmètre. Aucune nouvelle table prévue.

## Done when

- Le témoin 46_26S5_94_1 conduit au dossier fact_46_26S5_94_RUNGIS dans FRANCAIS/2026/S05.
- Une absence, une ambiguïté ou un accès refusé bloque le traitement.
- Un même classeur produit le même aperçu via les deux entrées.
- La recette sur compte autorisé est consignée séparément des simulations avant mise en service.

## Boundaries

L’epic import-fournisseur possède le raccord à la lecture du SAV, au parseur Excel et à l’écran fournisseur. Le stockage OneDrive du document généré reste sous la responsabilité du parcours existant.

## References

[Brief fonctionnel](sources/brief.md) · [Contrat REST](sources/infomaniak-kdrive-api.md)

## Notes

- Open question: La racine API du compte, la conversion année/semaine et les noms qui distinguent commandes actives, archives et copies restent à vérifier sur les dossiers réels. Toute éligibilité indéterminée bloque la sélection.
