---
title: "Product Brief: SAV Fruitstock — Phase 2 (Plateforme SAV interne + self-service client)"
status: "complete"
created: "2026-04-18"
updated: "2026-04-18"
author: "Antho"
mode: "guided + light brainstorming"
inputs:
  - "ROADMAP.md"
  - "docs/index.md"
  - "docs/integration-architecture.md"
  - "docs/api-contracts-vercel.md"
  - "docs/architecture-client.md"
  - "docs/project-overview.md"
  - "docs/component-inventory-client.md"
  - "_bmad-output/planning-artifacts/epics.md"
  - "_bmad-input/excel-gestion/SAV_Admin.xlsm (rétro-ingénierie)"
---

# Product Brief — SAV Fruitstock Phase 2

## Executive Summary

L'app SAV Fruitstock post-Epic 1 est une **passerelle de capture** : un formulaire qui collecte la demande client, pousse les fichiers sur OneDrive, et déclenche un webhook Make.com. **Tout le traitement reste hors de l'app**, dans un classeur Excel avec macros VBA (`SAV_Admin.xlsm`) qu'**une seule personne** manipule : import de l'Excel généré par l'app, import du fichier de facture, correction ligne à ligne, envoi d'email de confirmation via Make.com, génération du bon SAV PDF, export espagnol pour le fournisseur Rufino. 50 à 100 SAV par mois passent par ce goulot humain.

Ce brief cadre la **Phase 2** : transformer l'app de capture en **plateforme SAV complète** qui remplace intégralement le workflow Excel. Un back-office web pour l'opérateur (traitement, statuts, avoirs, Rufino, PDF), un self-service web pour les 8500 adhérents et les 3500 responsables de groupe (historique, suivi, commentaires), un reporting consolidé (produits problématiques, coût SAV annuel — invisible aujourd'hui), et des intégrations (ERP maison, notifications). **Big bang** : Excel est débranché le jour de la mise en prod.

Le "pourquoi maintenant" est double : (1) l'équipe SAV se réduit à 1 personne et Excel ne tient plus sous le volume redondant — copier/coller entre fichiers, incohérences, pas de mémoire persistante ; (2) le coût réel des SAV pour Fruitstock est aujourd'hui invisible, alors que c'est un levier de pilotage fournisseur majeur (export Rufino existe déjà, mais sans vue consolidée). Les fondations techniques sont prêtes : stack Vue 3 + Vercel serverless + OneDrive/Graph validée en Epic 1, patterns de retry, composables SAV, sanitization SharePoint, auth MSAL. La brique manquante est la couche **persistance + logique de traitement + UI opérationnelle**.

## Le Problème

**Une seule personne encaisse un volume croissant sur un outil non conçu pour ça.**

Le quotidien actuel, une fois la demande client reçue :

1. Ouvrir le template `SAV_Admin.xlsm`, cliquer "START"
2. Sélectionner dans le Finder le fichier Excel que l'app web a généré pour ce client, puis le `data.xlsx` de la facture correspondante
3. Laisser la macro copier les lignes dans `SAV_ADMIN`, `INFO_CLIENT`, `BDD`, `FACTURE_GROUPE`
4. Sauvegarder une copie `Demande_SAV_<client>_<timestamp>.xlsm`
5. Corriger ligne par ligne : valider `Quantité facturée`, ajuster `Avoir manuel` (TOTAL, 50 %, ou coefficient libre), traiter les conversions pièce↔kg dans la zone R/S "CALCUL PRIX SAV"
6. Cliquer un bouton pour déclencher `EnvoyerWebhookSAV` : aller chercher le prochain n° d'avoir dans un Google Sheet externe, construire l'email HTML charte Fruitstock, POST au webhook Make.com
7. Cliquer un autre bouton pour générer le bon SAV PDF (`<N°SAV> <Nom>.pdf`) — VLOOKUP sur `LISTE_MEMBRES`, TVA 5,5 %, remise responsable 4 %, export PDF
8. Pour les motifs liés au fournisseur : cliquer un 3ᵉ bouton pour générer l'export Rufino en espagnol (traduction des motifs, conversion des unités, IMPORTE = PESO × PRECIO)
9. Logger manuellement dans `LOG_ENVOIS` qui n'est même pas un journal persistant durable

**Les pathologies qui en découlent :**

- **Redondance** : les mêmes données voyagent 3-4 fois (app → Excel généré → SAV_Admin → email/PDF/Rufino)
- **Fragilité** : une erreur de colonne ou de mapping se propage silencieusement (`QTE NOK`, `à calculer`, `ATTENTION QTE FACTURE x` sont des sorties de formule, pas des vraies validations)
- **Amnésie** : pas de source de vérité sur ce qui a été traité, à part un dossier de fichiers `.xlsm` empilés. Impossible de répondre à "Quel SAV a-t-on fait pour ce client il y a 6 mois ?" sans fouille manuelle
- **Coût opaque** : impossible de produire le coût SAV annuel consolidé, ni d'identifier quels produits/fournisseurs coûtent le plus — alors que `RUFINO_GENERER_MAJ` existe, c'est le signe que le besoin est réel
- **Aucun self-service côté client** : l'adhérent qui a soumis son SAV n'a aucune visibilité, pas de canal pour commenter ou relancer — tout repose sur l'email équipe
- **Goulot humain** : 1 SPOF. Si la personne est absente, tout s'arrête. Si le volume passe de 100 à 200/mois, tout s'arrête aussi

**L'incident n'a pas encore eu lieu, mais le sablier s'écoule.**

## La Solution

**Une plateforme SAV unifiée sur l'app Vue existante** — back-office opérateur + self-service adhérent + reporting — qui remplace Excel en big bang.

### Zone back-office (opérateur SAV) — *priorité 1*

Liste des SAV avec filtres (statut, date, facture, client), vue détail par SAV, écran de traitement qui reprend les règles métier Excel actuelles :

- Transitions humaines de statut : **Reçue → Prise en charge → Validé → Clôturé**
- Calculs automatiques : prix TTC (× 1,055), avoir ligne (Qté × Prix × coefficient), conversions pièce↔kg/g, remise responsable 4 %
- Validations bloquantes : cohérence unités, quantité demandée ≤ facturée
- Numérotation séquentielle des avoirs (séquence BDD avec verrou transactionnel, seed initial = dernier n° du Google Sheet au jour de bascule, nouvelle émission atomique anti-collision même en cas de clics simultanés)
- Génération bon SAV PDF (template Fruitstock, charte + TVA + remise)
- Export fournisseur configurable — Rufino est la **première instance** de ce pattern (ES, motifs traduits, conversion unités, colonnes FECHA/REFERENCE/ALBARAN/…) ; l'architecture est générique pour accueillir d'autres fournisseurs sans nouveau code. Intégré au back-office dès la V1 — c'est un flux de remboursement fournisseur critique
- Envoi email de confirmation client via webhook Make.com (template HTML charte orange existant, à conserver tel quel)
- Journal persistant de tous les envois + transitions de statut (audit trail en BDD)

### Zone self-service (adhérent + responsable de groupe) — *priorité 2*

- Un adhérent consulte ses propres SAV : statuts en temps réel, fichiers déposés, commentaires équipe, montant avoir
- Un responsable de groupe (dimension AMAP) consulte les SAV de son groupe (adhérents qu'il coordonne)
- Commentaires bidirectionnels (client ↔ équipe) attachés à un SAV
- Notifications email à chaque changement de statut

### Zone reporting (opérateur + pilotage) — *priorité 3*

- Tableau de bord coût SAV mensuel / annuel consolidé
- Top produits problématiques, top motifs, top fournisseurs
- Export CSV/Excel pour analyses ad hoc
- Volumétrie et délais moyens de traitement

**KPIs proposés pour le dashboard V1** (à valider PRD) :
1. **Coût SAV mensuel / annuel** (somme des `Montant` clôturés, granularité jour/mois/année, comparatif N-1)
2. **Top 10 produits problématiques** sur 90 jours glissants (nb de SAV + coût cumulé par `CODE ARTICLE`)
3. **Délai moyen de traitement** (heures entre `Reçue` et `Clôturée`), avec distribution p50/p90

### Fondations techniques réutilisées (Epic 1)

- **SPA Vue 3 + Vercel serverless** : pas de nouveau runtime, pas de nouveau déploiement
- **OneDrive + MS Graph** : les fichiers existants restent où ils sont (on ne migre pas les fichiers), on référence leurs `webUrl` permanents
- **Auth MSAL + header `X-API-Key`** : étendu avec auth adhérent via **magic link signé à TTL court** (pas de lookup email+facture seul — vecteur d'énumération inacceptable pour 8500 comptes) et auth opérateur/admin (MSAL SSO cohérent avec Graph) **supportant dès la V1 plusieurs comptes Fruitstock** (rôle `admin` + rôle `sav-operator`) pour éviter le SPOF humain côté back-office
- **Payload Make.com actuel** : inchangé côté entrée (capture client) ; nouveaux webhooks côté sortie (email confirmation, notifications)
- **Pennylane** : les infos facture nécessaires sont déjà présentes dans l'Excel généré par l'app (B1/B3/B7 de `INFO_CLIENT`), donc pas d'appel Pennylane direct depuis la V1 — l'app reste la source du payload

## Ce qui rend cette approche différente

Il n'y a pas de concurrence au sens classique — c'est un outil interne. Le choix réel est entre :

- **(a) Continuer Excel** → statu quo, volume qui écrase l'opérateur unique
- **(b) Acheter un SaaS SAV générique** (Zendesk, Freshdesk, Gorgias, HelpScout) → aucun ne gère les spécificités Fruitstock : dimension AMAP/groupes/responsables, TVA 5,5 % agricole, remise responsable 4 %, export Rufino espagnol, calcul pièce↔kg sur catalogue fruits, numérotation avoirs, interface avec un ERP maison. L'effort d'adaptation serait équivalent à une construction
- **(c) Étendre l'app existante** (choix retenu) → réutilise 100 % des fondations Epic 1, porte fidèlement la logique métier déjà éprouvée dans Excel (formules, règles, workflow), et verrouille la connaissance métier dans du code maintenable plutôt que dans un classeur macro

**L'angle** : la migration Excel → code n'est pas un greenfield, c'est une **codification de savoir-faire**. Les 15 modules VBA, les 13 feuilles, les formules critiques, les listes de validation sont une **spécification métier complète déjà validée par l'usage**. Le risque "on découvre le besoin en cours de route" est massivement réduit — on transpose, on ne conçoit pas.

## Qui c'est sert

**Utilisateur primaire — Opérateur SAV (1 personne, Fruitstock)**
Gère aujourd'hui 50-100 SAV/mois manuellement via Excel+macros. Vit la douleur quotidiennement. Veut : moins de clics, moins de double-saisie, plus de visibilité sur l'historique, un dashboard qui remplace les mental maths. L'aha moment : premier jour où le bon SAV, l'email et l'export Rufino sont générés **en un seul flux** depuis le détail d'un SAV, sans passer par un fichier Excel.

**Utilisateur primaire — Adhérent Fruitstock (≈ 8500)**
Soumet une demande SAV aujourd'hui et ne voit rien passer — tout vit dans l'email de confirmation reçu X jours plus tard. Veut : vérifier où en est sa demande, ajouter un commentaire, consulter l'historique. L'aha moment : se reconnecter après une soumission et voir le statut "Prise en charge" avec le nom de l'opérateur, au lieu d'attendre.

**Utilisateur secondaire — Responsable de groupe (≈ 3500)**
Coordonne les commandes d'un groupe d'adhérents (dimension AMAP). Bénéficie de la remise 4 % sur ses bons SAV personnels. Veut : voir les SAV des adhérents de son groupe, pour arbitrer / filtrer / relancer sans passer par l'équipe Fruitstock.

**Buyer = User** : le brief est produit par Antho pour Antho. Pas de validation stakeholder externe à décrocher.

## Success Criteria

Classés par ordre d'importance pour Antho :

1. **⏱️ Temps de traitement d'un SAV ≤ 5 minutes** (mesuré bout-en-bout : du clic "Prendre en charge" à la clôture avec email + PDF + Rufino générés). Objectif volumétrique implicite : permettre à 1 personne de traiter 200-300 SAV/mois sans stress, avec marge pour croissance.

2. **💰 Coût SAV annuel consolidé visible dans un tableau de bord** — métrique aujourd'hui impossible à produire sans retraitement manuel. Inclut : total remboursé aux adhérents, top produits/fournisseurs problématiques, évolution mensuelle.

3. **🔌 Excel débranché à J+1 mise en prod** — zéro `SAV_Admin.xlsm` utilisé, zéro dépendance Google Sheet numérotation avoirs, zéro fichier `Demande_SAV_*.xlsm` créé.

4. **👥 Adoption self-service client** — proportion d'adhérents qui consultent au moins une fois leur espace SAV dans les 30 jours suivant une soumission. Seuil de succès à définir à l'usage (indicatif : > 40 %).

5. **📉 Baisse tendancielle du volume SAV** grâce à la visibilité reporting (identifier les produits qui récidivent → actions fournisseur). Métrique de long terme, pas V1.

Anti-métriques (à surveiller) : temps perdu sur des bugs / régressions par rapport à Excel, nombre d'escalades client "je ne trouve pas mon SAV".

## Scope

### V1 (Palier C big bang — tout porter, débrancher Excel)

**IN :**
- Back-office opérateur : liste, détail, transitions statut, calculs métier Excel portés (TVA 5,5 %, remise 4 %, avoir ligne, conversion pièce↔kg), validations bloquantes
- Numérotation avoirs en BDD (séquence migrée depuis Google Sheet interne, verrou transactionnel)
- Génération bon SAV PDF (template Fruitstock + TVA + remise responsable 4 %)
- Export fournisseur générique (Rufino = instance 1 : ES, traduction motifs, conversion unités, colonnes FECHA/REFERENCE/ALBARAN/…)
- Envoi email confirmation client (payload Make.com existant, template HTML charte orange conservé)
- Notifications email : client à chaque changement de statut, opérateur à chaque nouveau SAV
- Self-service adhérent : historique, détail, commentaires bidirectionnels, fichiers, **reprise de brouillon côté serveur**
- Self-service responsable de groupe : vue étendue aux adhérents de son groupe
- Reporting : dashboard coût SAV consolidé, top produits/motifs/fournisseurs, export CSV, **alertes de seuil** (notif opérateur si un produit dépasse N SAV/semaine)
- **Recherche full-text** sur SAV, commentaires, motifs (tue le pain point "retrouver ce SAV d'il y a 6 mois")
- **Tags libres** sur SAV (`tags[]` : "litige fournisseur", "VIP", "à rappeler" — axe de tri/reporting bonus)
- **Duplication d'un SAV en brouillon** pour l'opérateur (réduction de la saisie redondante)
- Intégration API ERP maison : push automatique au passage "Clôturé" (traçage coût/revenu par commande)
- Audit trail : journal de toutes les transitions de statut + envois email
- **Auth multi-tier multi-utilisateurs** : opérateur/admin (MSAL SSO, **plusieurs comptes Fruitstock dès la V1** pour anti-SPOF), adhérent (magic link signé + TTL + rate limiting), responsable (idem + scope étendu aux adhérents du groupe)

**OUT (explicitement) :**
- **Import ou consultation in-app de l'historique Excel** : la V1 démarre vierge. Les SAV antérieurs à la bascule restent dans les fichiers `.xlsm` archivés **hors app**. Politique communiquée aux adhérents dès D-30 avec script de réponse type pour l'équipe ("pour les SAV antérieurs au JJ/MM/AAAA, contactez-nous à sav@...").
- **Appel Pennylane direct** : les infos facture arrivent via l'Excel généré par l'app (source figée). Intégration Pennylane côté serveur reportée si besoin ultérieur.
- **Multi-langues UI** : FR only. Les exports fournisseur restent dans la langue cible (Rufino = ES).
- **Fonctionnalités non-SAV** : pas de gestion commande, pas de paiement, pas de catalogue produit, pas de gestion stock. Strictement SAV.
- **Mobile natif** : responsive web suffit. Pas d'app iOS/Android.

### Séquencement interne (dans le big bang, ordre de livraison)

1. **Persistance + back-office opérateur + Rufino + bon SAV PDF** (priorité 1 : tuer Excel) — *c'est ce qui fait mal tous les jours*
2. **Self-service adhérent + responsable** (priorité 2 : valeur client)
3. **Reporting + intégration ERP** (priorité 3 : pilotage)

Mise en prod = tout livré en même temps. Excel continue d'exister en parallèle uniquement le temps du dev, **jamais en prod**.

## Vision

Phase 2 = transformer l'app SAV de **passerelle en plateforme**. La V1 doit être un **terminus fonctionnel viable** : si Fruitstock décide de s'arrêter là, l'outil tient seul, sans dette cachée.

Horizon 2-3 ans non arrêté, mais la persistance V1 ouvre naturellement plusieurs directions qu'il vaut la peine de **nommer** sans les engager, car elles deviennent peu coûteuses une fois la BDD en place :

- **Pilotage fournisseur structuré** : passer de "export Rufino" à un cockpit fournisseurs (scorecards, dossiers de négo trimestriels auto-générés depuis l'historique SAV). Rufino étant traité comme instance 1 d'un pattern d'export générique, l'ajout d'autres fournisseurs est marginal.
- **Prévention amont** : photo systématique à la réception par le responsable de groupe, auto-détection d'anomalies de facturation, scoring commande à risque. Réduit la source des SAV plutôt que de mieux les traiter.
- **Dimension communautaire AMAP** : signalement amont par les responsables (pré-remplir les SAV des adhérents d'un groupe quand un lot est défectueux), vue agrégée "ma tournée" pour un responsable. Effet de levier sur 3500 responsables aujourd'hui inexploités.
- **Plateforme opérationnelle élargie** : commandes, pilotage groupe, compta intégrée. La plateforme SAV devient le socle.
- **API read-only des données SAV** pour brancher un BI externe sans retoucher l'app.
- **Optionalité SaaS AMAP** : la logique TVA 5,5 % + remise responsable + groupes + export fournisseur multilingue est réutilisable par d'autres AMAP. À poser comme possible, sans priorisation.

Ces pistes ne sont pas dans le scope V1. Elles sont mentionnées parce que les choix d'architecture V1 doivent les laisser **possibles à moindre coût**, pas parce qu'elles sont promises.

## Budget & engagement

Antho s'engage sur le **scope V1 complet tel qu'écrit** (Palier C big bang, toutes les fonctionnalités IN listées, y compris les extensions à faible coût marginal recherche/tags/brouillon/alertes). Pas de coupe de scope anticipée. Les arbitrages de priorisation interne seront portés par le PRD / sprint planning au fil du dev.

## Risques & hypothèses critiques

- **Big bang de migration** : risque si la V1 a un bug bloquant en prod (Excel déjà débranché). **Mitigation** : phase de **shadow run de 2-4 semaines** avant la bascule (tout SAV traité simultanément dans app + Excel, comparaison ligne à ligne des sorties PDF/email/Rufino), critères de go/no-go chiffrés, procédure de rollback documentée avec décideur nommé (voir "Plan de cutover").
- **Continuité pendant le développement** : Excel reste en prod pendant 3-6 mois de dev. Risques : (a) lockdown macros Office 365 / maj Windows / corruption classeur → perte de l'outil avant que l'app ne soit prête ; (b) 200-600 SAV créés pendant le dev = invisibles au jour J si "V1 démarre vierge". **Mitigation** : snapshot Excel + tous les `Demande_SAV_*.xlsm` archivés en lecture seule accessibles à l'opérateur (consultation archivistique hors-app) ; en V1.1 éventuelle, import minimal lecture seule pour closer les SAV en cours.
- **Bus factor Antho** : Antho = dev + product owner + détenteur de tous les secrets (MSAL, Make.com, Pennylane, webhook URLs). Absence prolongée = arrêt total du projet ET éventuellement du SAV en cas d'incident. **Mitigation confirmée** : (a) l'app supporte dès la V1 plusieurs comptes admin côté back-office (cf Solution) → une seconde personne Fruitstock peut prendre le relais opérationnel ; (b) rédaction d'un **runbook opérateur/admin** (login, génération PDF, relance webhook, rotation token, cutover) ; (c) partage des secrets dans un coffre-fort (type Bitwarden/1Password) accessible à au moins une seconde personne Fruitstock ; (d) fenêtre de cutover non-chevauchante avec les congés prévus d'Antho.
- **Courbe de formation opérateur unique** : 1 personne = un seul utilisateur à former, mais aussi un seul à décrocher si l'UX clashe avec ses habitudes Excel. **Mitigation** : itération rapprochée avec l'opérateur pendant le dev, réplication fidèle des flux Excel au début (raccourcis, ordre des actions), shadow run utilisé aussi comme période de formation.
- **Règles métier non documentées** : la rétro-ingénierie Excel a révélé des zones floues (coexistence `SAV_ADMIN` vs `SAV_ADMIN__`, convention Infos Client B1/B3/B7/B9/B10, rôle de "A SÉLECTIONNER", FDP dans certains calculs, token Pennylane hardcodé en VBA). **Mitigation** : lever chaque flou au PRD / architecture, traiter les cas limites en stories dédiées, rotation du token Pennylane lors de la migration.
- **Persistance vs stockage fichiers** : leçon v1 abandonnée = ne pas recompacter dans un seul système. **Mitigation** : DB (métadonnées SAV) + OneDrive (fichiers) restent découplés — confirmé comme pattern gagnant.
- **Dépendance Make.com** : actuellement le webhook sort un email. Si Make.com tombe, pas d'email. **Mitigation Phase 2 (tranchée au PRD)** : suppression de Make.com en sortie et passage à un envoi SMTP serveur-à-serveur direct depuis Vercel via Nodemailer, sur le compte mail **Infomaniak** existant de Fruitstock (hébergement Suisse, décision d'adéquation RGPD UE→CH valide). Note : ceci ne remet pas en cause la sortie du serveur Express Infomaniak réalisée en Epic 1 — il s'agit uniquement d'utiliser le service mail SMTP du même hébergeur. Retry queue persistée (`email_outbox`) pour absorber une indispo temporaire du relais SMTP.
- **RGPD & self-service 8500 adhérents** : données perso + financières exposées à l'URL. **Mitigation** : magic link signé + TTL court + rate limiting anti-énumération + logs d'accès + DPIA léger à produire avant mise en prod.
- **Concurrence d'écriture** : self-service + commentaires bidirectionnels = lectures/écritures concurrentes. **Mitigation** : verrou optimiste (`updated_at` en version), transactions courtes, merge automatique pour les commentaires append-only.
- **Évolution réglementaire** : TVA 5,5 % et remise responsable 4 % sont aujourd'hui hardcodées en VBA. **Mitigation** : les exposer en paramètres configurables dès la V1 (table `settings` ou fichier de config versionné).

## Plan de cutover (à détailler au PRD, cadrage V1)

- **D-30** : email d'annonce adhérents + FAQ en ligne + URL dédiée + script support.
- **D-14 → D-0** : shadow run — tout SAV saisi en parallèle dans app et Excel, comparaison automatisée des sorties (montant, PDF, export Rufino), tableau de bord de conformité. Critères de go : ≥ N SAV traités bout-en-bout sans intervention manuelle, zéro bug P1 sur 7 jours consécutifs.
- **Jour J (lundi matin idéalement, jamais vendredi)** : gel des saisies Excel à T-1h, re-saisie des SAV "en vol" (statut `Prise en charge`) dans l'app, bascule de la numérotation avoirs (dernier n° Google Sheet → seed BDD), smoke test bout-en-bout, annonce adhérents.
- **J+0 → J+7** : critères de rollback écrits (> 2 SAV bloqués / envoi email KO > 4h / PDF malformé > 5 % / etc.), décideur nommé, procédure technique de reprise Excel documentée. Gel fonctionnel : bug fix only, zéro feature.
- **Prérequis J+0** : snapshot BDD automatique + test de restauration fait au moins 1 fois avant bascule, dump complet Excel archivé, runbook opérateur imprimé + PDF, monitoring alertant sur 0 SAV clôturé en 24h ou webhook KO.

## Inputs utilisés pour ce brief

- `ROADMAP.md` (section Phase 2)
- `docs/index.md`, `docs/integration-architecture.md`, `docs/api-contracts-vercel.md`, `docs/architecture-client.md`, `docs/project-overview.md`, `docs/component-inventory-client.md`
- `_bmad-output/planning-artifacts/epics.md` (plan v1 Supabase abandonné)
- `_bmad-input/excel-gestion/SAV_Admin.xlsm` (rétro-ingénierie complète : 13 feuilles, ≈15 modules VBA, 2400 lignes VBA, intégrations Pennylane / Google Sheet / Make.com / Rufino)
- Discovery interactive avec Antho (4 angles brainstorming + 10 questions de cadrage)
