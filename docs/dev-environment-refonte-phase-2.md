# Stratégie de dev refonte-phase-2 — sans casser le main

> Document créé 2026-04-27 suite à la session de code-review Story 5.3 + audit Make.
> Objectif : permettre de continuer le dev de la refonte (back-office Vue + Supabase) **sans dépendre des previews Vercel** et **sans aucun risque d'impact sur le main de prod actuel**.

## TL;DR

- **main** est isolé. Tu peux push refonte-phase-2 autant que tu veux, ça n'affecte **jamais** la prod cliente actuelle (audit confirmé : main = 2 handlers OneDrive, pas de Supabase).
- Pour le dev quotidien, utilise `npx vercel dev` en local. C'est instantané, MSAL marche, pas de preview à attendre.
- Pour les besoins externes ponctuels (test webhook Make réel, démo, bench p95) : un domaine custom Vercel attaché à la branche `refonte-phase-2`. URL stable, redirect URI Azure whitelisté **une fois pour toutes**.
- DB Supabase `app-sav` (`viwgyrqpyryagzgvnfoi`) sert à la fois pour dev et pour prod-future. Tant qu'on n'a pas de SAV client réels dedans, c'est OK. Plus tard, on pourra splitter.

## Isolation main / refonte-phase-2

```
                                          ┌──────────────────────────────┐
                                          │  Vercel — Production         │
   git push origin main         ───────►  │  (déploie main, HEAD 93db4aa)│
                                          │  URL : <prod stable>         │
                                          │  Code : 2 handlers OneDrive  │
                                          │  Pas de Supabase             │
                                          └──────────┬───────────────────┘
                                                     │
                                                     ▼
                                          Clients externes
                                          (formulaire SAV)
                                                     │
                                                     ▼
                                          Make scenarios 1 & 2
                                          → emails sav@, Trello, accusé client


   git push origin refonte-     ───────►  ┌──────────────────────────────┐
   phase-2                                │  Vercel — Preview            │
                                          │  (déploie refonte-phase-2)   │
                                          │  URL : <preview unique/stable │
                                          │         selon config domaine) │
                                          │  Code : ~15 handlers + admin │
                                          │  + Supabase                  │
                                          └──────────┬───────────────────┘
                                                     │
                                                     ▼
                                          Antho (dev), pas de client externe
                                                     │
                                                     ▼
                                          Supabase app-sav
                                          (DB partagée dev/prod-future)
```

Les deux URLs Vercel sont **indépendantes**. Pas de DNS partagé, pas d'env var partagée (sauf si tu choisis de les partager dans Vercel → Settings → Environment Variables → All Environments). La prod main ne tape pas Supabase, donc rien de ce qu'on fait en DB n'impacte le flow client actuel.

## Setup 1 — `vercel dev` en local (recommandé pour le dev quotidien)

### Prérequis

1. **`.env.local` dans `client/`** avec les env vars nécessaires. Liste minimale pour faire tourner les 4 endpoints reporting + auth opérateur :

```
SUPABASE_URL=https://viwgyrqpyryagzgvnfoi.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service role key depuis dashboard Supabase>
SUPABASE_ANON_KEY=<anon key>

JWT_SECRET=<une string aléatoire 64+ chars>

MICROSOFT_TENANT_ID=<depuis Azure App Registration>
MICROSOFT_CLIENT_ID=<idem>
MICROSOFT_CLIENT_SECRET=<idem>

# Pour les emails (Story 5.7 et magic-link)
SMTP_HOST=<...>
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=<...>
SMTP_PASSWORD=<...>
```

⚠️ **Ne JAMAIS commit `.env.local`** (vérifié dans `.gitignore`). Pour partager les valeurs avec un autre dev : 1Password / Bitwarden / Vercel CLI `vercel env pull`.

2. **Azure App Registration** : ajouter `http://localhost:3000/api/auth/msal/callback` dans la liste des Redirect URIs. **À faire UNE FOIS**, valable pour toutes les prochaines sessions de dev.

### Démarrage

```bash
cd /Users/antho/Dev/sav-monorepo/client
npx vercel dev
# ➜ Ready on http://localhost:3000
```

### Login en dev

Tu navigues sur `http://localhost:3000/admin/sav` → redirect MSAL → tu te logges avec ton compte opérateur Fruitstock → cookie `sav_session` posé sur `localhost:3000` → tu accèdes à toute l'app.

### Avantages

- Feedback instantané : modification de fichier → rechargement immédiat.
- MSAL fonctionne complètement.
- Les SAV de test arrivent dans `app-sav` (la même DB que la future prod, donc cohérent).
- Pas de preview Vercel à attendre (build 30-60 s).
- Pas de redirect URI à gérer à chaque push.

### Limites

- Tu ne peux pas pointer un webhook externe (Make.com) vers `http://localhost:3000` — c'est ton réseau local, pas accessible publiquement. Pour ça → Setup 2.

## Setup 2 — Domaine custom Vercel sur `refonte-phase-2` (pour besoins externes)

### Quand tu en as besoin

- Tester un webhook Make réel qui POST vers refonte-phase-2 (Story 5.7 phase de double-écriture).
- Lancer le bench p95 réel contre une URL publique stable.
- Faire une démo à un collègue.

### Mise en place (une fois)

1. **Vercel dashboard** → ton projet `sav-monorepo-client` → Settings → Domains → Add Domain.
2. Renseigne un domaine, deux options :
   - **Sous-domaine de ton domaine Fruitstock** : `sav-staging.fruitstock.eu` (recommandé, propre, pro).
   - **Sous-domaine Vercel gratuit** : `sav-staging-fruitstock.vercel.app` (ou similaire si dispo).
3. Dans la config du domaine, choisis **Branch: `refonte-phase-2`** (PAS Production qui est `main`).
4. Vercel génère les enregistrements DNS à pointer (CNAME ou A) — ajoute-les chez ton registrar.
5. **Azure App Registration** : ajoute `https://sav-staging.fruitstock.eu/api/auth/msal/callback` dans Redirect URIs. Une fois pour toutes.
6. **Vercel Environment Variables** scope **Preview** (pas Production) : ajoute toutes les env vars du `.env.local` (sauf `localhost`-spécifiques). Vercel chiffre, sécurisé.

### Résultat

- `https://sav-staging.fruitstock.eu` pointe **toujours** sur le dernier déploiement de `refonte-phase-2`.
- Chaque `git push origin refonte-phase-2` → Vercel rebuild → le domaine sert automatiquement la nouvelle version. **Aucune URL changeante.**
- Le redirect URI Azure n'a plus jamais besoin d'être mis à jour.
- Tu peux pointer Make webhook vers cette URL pour la phase de double-écriture (Story 5.7 AC #6).

### Avantages

- URL stable, prévisible, professionnelle.
- Indépendante du nom des branches/PRs.
- Pas de friction MSAL.

### Coût

- Si tu utilises ton propre domaine : 0 €.
- Si tu utilises un domaine Vercel : 0 € (plan gratuit/hobby).

## Setup 3 — DB Supabase staging séparée (optionnel, plus tard)

### Quand tu en auras besoin

Aujourd'hui, `app-sav` joue le double rôle de DB de dev et de DB de prod-future. Tant que tu n'as pas mis refonte-phase-2 en prod réelle (= clients externes qui créent des SAV via la nouvelle URL), c'est OK : il n'y a pas de données « business » à protéger.

**À ~1-2 semaines du cutover réel** (quand tu vas brancher Make webhook 2 sur `https://<prod-url>/api/webhooks/capture`), tu voudras :

1. Créer un nouveau projet Supabase `sav-staging` (clone de `app-sav`).
2. Y appliquer toutes les migrations (`npx supabase db push --include-all` lié sur `sav-staging`).
3. Pointer `vercel dev` local + le déploiement preview (Setup 2) sur `sav-staging` au lieu de `app-sav`.
4. Garder `app-sav` propre comme DB de prod réelle.

### Pas urgent

À faire quand le moment vient. Pour l'instant, `app-sav` partagé est cohérent : rien dedans n'a de valeur business à perdre.

## Récap décisionnel

| Ce que tu veux faire | Setup |
|---|---|
| Itérer sur du code (90 % du dev quotidien) | Setup 1 — `vercel dev` |
| Tester l'auth MSAL en local | Setup 1 |
| Run les tests Vitest | direct, pas besoin de Vercel |
| Tester un webhook Make en réel | Setup 2 |
| Faire une démo à un collègue | Setup 2 |
| Lancer le bench p95 réel | Setup 2 |
| Préparer le cutover prod (D-7) | Setup 2 + Setup 3 |
| Cutover prod (D-Day) | promotion `main` (= merge refonte-phase-2 → main) |

## Pour le cutover prod (le « jour J »)

Ce n'est pas urgent — c'est dans plusieurs semaines/mois. Mais pour mémo :

1. Tu auras complété Story 5.7 (Pennylane natif + emails) + idéalement Stories 5.4, 5.5, 5.6 + Epic 6 (espace adhérent) selon ton scope.
2. Tu auras configuré toutes les env vars Vercel scope **Production** (les mêmes que Preview, valeurs prod réelles).
3. Tu auras whitelisté le redirect URI prod dans Azure (`https://<prod-url>/api/auth/msal/callback`).
4. Tu auras laissé tourner la phase de double-écriture Make pendant ≥ 1 semaine pour valider.
5. Le jour J : merge `refonte-phase-2 → main` → Vercel deploy l'URL prod avec le nouveau code → tu désactives Make scenario 2 → tout passe par l'app.

Le merge lui-même n'est pas magique — c'est juste la promotion du code refonte-phase-2 sur la branche principale. Vercel s'occupe du reste si les env vars prod sont prêtes.

## Anti-patterns à éviter

❌ **Ne pas attendre une preview Vercel** pour itérer. Use `vercel dev` local.

❌ **Ne pas whitelister un redirect URI Azure par déploiement preview**. Utilise un domaine custom stable (Setup 2).

❌ **Ne pas pousser des données de test massivement** dans `app-sav` sans réfléchir. Si tu génères 10k SAV de test, prévois un script de purge avant le cutover prod (ou crée Setup 3 maintenant).

❌ **Ne pas confondre « preview MSAL bug » et « refonte-phase-2 cassée »**. Si la preview rend 401, c'est juste un manque d'env vars + redirect URI — pas un bug applicatif. Setup 2 résout définitivement ce sujet.
