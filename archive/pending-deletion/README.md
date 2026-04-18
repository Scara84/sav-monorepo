# Pending deletion — Epic 1 cleanup

> **⚠️ Ces fichiers seront supprimés définitivement dans un prochain commit.**
>
> Ce dossier est une zone de transit : rien n'est encore perdu grâce à `git mv` qui a préservé l'historique de chaque fichier. Avant la suppression finale, Antho fait une copie locale au cas où une restauration serait nécessaire (au-delà de ce que git permet).

## Contenu

| Chemin | Origine | Raison de suppression |
|--------|---------|-----------------------|
| [server/](./server/) | `/server/` (racine repo) | Backend Express obsolète — logique MSAL/Graph portée vers [client/api/](../../client/api/) en story 1.1 |
| [client-server.js](./client-server.js) | `/client/server.js` | Entrypoint Express utilisé par Infomaniak pour servir `dist/` — inutile sur Vercel |
| [client-netlify.toml](./client-netlify.toml) | `/client/netlify.toml` | Config Netlify (cible alternative historique) — abandonnée, Vercel est la seule cible depuis Epic 1 |

## Dépendances encore liées

Les deps `express` et `dotenv` sont toujours présentes dans [client/package.json](../../client/package.json) car elles étaient importées par `client/server.js` (maintenant déplacé). Elles seront retirées lors de la suppression finale de ce dossier.

## Procédure de suppression finale

Après validation (copie locale faite par Antho) :

```bash
git rm -rf archive/pending-deletion/
# Retirer deps devenues orphelines
# (édition manuelle de client/package.json : retirer "express" + "dotenv")
cd client && npm install
# Vérifier tests : npx vitest run && npx playwright test
git add -A
git commit -m "chore(epic-1): final removal of legacy Infomaniak server + related files"
git push
```

## Procédure de restauration (si besoin)

- **Via git** : `git log --all -- archive/pending-deletion/server/server.js` pour retrouver l'historique, puis `git checkout <sha> -- <path>`.
- **Via copie locale** : Antho restaure depuis sa copie hors-repo (mesure de sécurité additionnelle).

## Dates

- **Déplacé le** : 2026-04-18 (commit à venir)
- **Suppression finale prévue** : sur accord explicite d'Antho après copie locale.
- **Décommissionnement Infomaniak (physique)** : 2 semaines après merge d'Epic 1 sur `main`.
