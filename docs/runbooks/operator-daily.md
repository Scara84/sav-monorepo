# Runbook — Opérations quotidiennes opérateur

> **Audience** : Opérateur non-dev Fruitstock
> **Objectif** : Procédures quotidiennes complètes : connexion, gestion SAV, émission avoir, suivi adhérent
> **Prérequis** : Accès navigateur, compte opérateur créé par admin, adresse email Fruitstock enregistrée

---

## TL;DR

1. Connexion → magic-link reçu par email → cliquer le lien
2. Tableau de bord → liste des SAV en cours
3. Capturer un nouveau SAV (Story 2.x)
4. Faire progresser les statuts
5. Émettre un avoir si besoin (Story 4.4)
6. Suivi adhérent self-service (Story 6.x)

---

## 1. Connexion (Story 1.5 — magic-link opérateur)

### 1.1 Demander un lien de connexion

1. Ouvrir `https://sav.fruitstock.eu/login` dans le navigateur
2. Saisir votre **adresse email opérateur** dans le champ prévu
3. Cliquer **Envoyer le lien de connexion**
4. Vérifier votre boîte email (incluant les spams)
5. Cliquer le lien reçu (valable **15 minutes**)
6. Vous êtes automatiquement connecté et redirigé vers le tableau de bord

<!-- CAPTURE: docs/runbooks/screenshots/operator-daily/01-login.png -->

> **Note** : Le lien est à usage unique. Si expiré, recommencer depuis l'étape 1.

### 1.2 Si le lien ne fonctionne pas

- Vérifier que l'adresse email est bien enregistrée (contacter l'admin si besoin)
- Vérifier que le lien n'est pas modifié par le client email (copier-coller l'URL complète)
- Le lien expire après 15 minutes — en demander un nouveau

---

## 2. Tableau de bord SAV (Story 3.x — liste et détail)

### 2.1 Consulter la liste des SAV

1. Depuis le menu principal → **SAV**
2. La liste affiche tous les SAV avec leur statut et date
3. Utiliser les filtres (statut, date, adhérent) pour affiner
4. Cliquer sur un SAV pour voir le détail

### 2.2 Statuts des SAV

| Statut | Signification |
|--------|--------------|
| `pending` | SAV reçu, en attente de traitement |
| `in_progress` | SAV en cours d'instruction |
| `validated` | SAV validé, avoir en préparation |
| `closed` | SAV clôturé, avoir émis |

### 2.3 Faire progresser un statut

1. Ouvrir le détail du SAV
2. Cliquer sur le bouton de transition (ex. **Mettre en cours**)
3. Confirmer si demandé
4. Le statut est mis à jour immédiatement

---

## 3. Capturer un nouveau SAV (Story 2.x)

### 3.1 Créer un SAV depuis le tableau de bord

1. Cliquer **Nouveau SAV** en haut de la liste
2. Rechercher l'adhérent par nom ou email
3. Renseigner les informations :
   - **Cause** : sélectionner dans la liste (ex. "Produit abîmé")
   - **Lignes** : ajouter les produits concernés avec quantité
   - **Bon de retour** : uploader le fichier PDF si disponible
4. Cliquer **Créer le SAV**
5. Le SAV apparaît en statut `pending`

<!-- CAPTURE: docs/runbooks/screenshots/operator-daily/02-new-sav.png -->

### 3.2 Upload bon de retour (OneDrive)

Le fichier est automatiquement envoyé vers OneDrive. En cas d'erreur upload :

1. Vérifier la connexion internet
2. Vérifier que le fichier fait moins de 10 MB
3. Réessayer — le système gère l'idempotence

---

## 4. Émission d'un avoir (Story 4.4)

### 4.1 Pré-requis

- Le SAV doit être en statut `validated`
- Vérifier les lignes et montants dans le détail

### 4.2 Émettre l'avoir

1. Ouvrir le SAV en statut `validated`
2. Cliquer **Émettre l'avoir**
3. Vérifier le récapitulatif (montant HT, TVA, TTC)
4. Confirmer l'émission
5. L'avoir est généré avec un numéro séquentiel (ex. AV-4568)
6. Le PDF est disponible immédiatement via **Télécharger le PDF**
7. Un email de confirmation est envoyé à l'adhérent

> **Note** : Le numéro d'avoir est définitif et comptable — impossible d'annuler après émission.

---

## 5. Suivi adhérent self-service (Story 6.x)

### 5.1 Consulter le profil adhérent

1. Depuis le menu → **Adhérents**
2. Rechercher par nom ou email
3. Cliquer sur l'adhérent pour voir :
   - Historique des SAV
   - Avoirs émis
   - Coordonnées

### 5.2 Accès self-service adhérent

Les adhérents peuvent consulter leurs SAV et avoirs directement via leur portail.
En cas de problème d'accès adhérent, diriger vers `https://sav.fruitstock.eu/member/login`.

---

## Si ça casse

### Problème de connexion magic-link

- Vérifier la boîte spam
- Vérifier que l'email est bien enregistré (contacter admin)
- Contacter le tech-lead si le service email est en panne (voir [incident-response.md](incident-response.md))

### SAV ne s'affiche pas

1. Rafraîchir la page (F5)
2. Vérifier les filtres actifs (bouton **Réinitialiser les filtres**)
3. Si persistant → contacter admin

### Erreur lors de la création d'un SAV

1. Vérifier que l'adhérent existe dans le système
2. Vérifier que les produits sont dans le catalogue
3. Copier le message d'erreur et contacter le tech-lead

### Avoir non émis

1. Vérifier que le SAV est bien en statut `validated`
2. Vérifier qu'aucun avoir n'existe déjà pour ce SAV
3. Si message d'erreur séquence → contacter immédiatement le tech-lead (incident critique)

---

**Dernière mise à jour** : 2026-05-01 — Story 7.7 V1
