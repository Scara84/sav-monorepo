# Assets PDF bon SAV

Dossier consommé par `client/api/_lib/pdf/CreditNotePdf.ts`.

## Contenu attendu

- `fruitstock-logo.png` (ou `.svg`) — **à fournir par design**. Tant que l'asset n'est pas livré, le composant rend un stub carré orange (View + Text « F »). Voir Story 4.5 AC #12 + `docs/charte-fruitstock-pdf.md` pour la procédure de remplacement.

## Pourquoi server-side et pas dans `public/`

Ces binaires sont consommés **uniquement** par le code serverless `@react-pdf/renderer`. Les placer dans `public/` les embarquerait dans le bundle client Vite inutilement (+ taille bundle, + cache navigateur inutile). Les laisser ici garantit qu'ils restent dans le scope serveur.
