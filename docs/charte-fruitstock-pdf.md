# Charte visuelle PDF — Bon SAV Fruitstock

**Story 4.5** — référence design pour `client/api/_lib/pdf/CreditNotePdf.ts`.

## Palette

| Rôle            | Code       | Usage                                          |
| --------------- | ---------- | ---------------------------------------------- |
| Orange primaire | `#F57C00`  | Logo, titre société, en-tête tableau, totaux   |
| Noir texte      | `#222222`  | Corps de texte général (Helvetica)             |
| Gris ligne      | `#CCCCCC`  | Bordures tableau, séparateurs                  |
| Gris clair      | `#F7F7F7`  | Fond des lignes paires (alternance tableau)    |
| Gris footer     | `#666666`  | Mentions légales bas de page                   |
| Avertissement   | `#8A4400`  | Ligne non comptabilisée (icône ⚠)              |

## Typographie

- Famille : `Helvetica` (built-in @react-pdf, aucun TTF embed — justification : +500 Ko par font ajoutés au bundle serverless, hors budget).
- Tailles :
  - Titre (« BON SAV » / « AVOIR ») : `18pt bold`
  - Raison sociale société : `10pt bold`
  - Corps général : `9pt`
  - Adresse société, tableau : `8.5–9pt`
  - Footer mentions légales : `7.5pt`
- Basculer vers `Roboto` ou `Open Sans` → `Font.register({ family, src: '<.ttf>' })` dans `CreditNotePdf.ts` puis remplacer `fontFamily: 'Helvetica'` par la nouvelle famille. Poids ~200-500 Ko supplémentaires par TTF.

## Mise en page (A4 portrait, 210 × 297 mm)

- Marges : `15 mm` haut/bas (`42pt`), `12 mm` gauche/droite (`34pt`).
- Logo : carré `40 × 40 pt` en haut gauche, fond orange `#F57C00`, `F` blanc bold centré (stub — à remplacer par l'asset officiel, voir ci-dessous).
- Bloc société : aligné à droite de l'en-tête, 4 lignes (adresse, CP + ville, SIRET, TVA intra).
- Titre : centré sur une ligne propre après le header.
- Bloc références : 2 colonnes `flex: 1`, gauche = N° Avoir / Date / Réf. SAV, droite = Client / Groupe / Facture liée.
- Tableau lignes (9 colonnes) : `N° | Code | Produit | Qté dem. | Unité | Qté fact. | Prix HT | Coef | Montant` (orange bold en-tête, alternance ligne grise).
- Totaux : bas-droite, bloc `220pt` de large, `Sous-total HT` / `Remise 4 % (responsable)` (conditionnelle) / `TVA` / **`Total TTC`** (bold orange).
- Footer : bordure haute grise, mentions légales + SIRET + téléphone + email + pagination `Page N / M`.

## Règles @react-pdf à respecter

- Uniquement `flexbox` — `position: absolute` est stable uniquement dans le footer (`fixed: true`).
- Header + footer `fixed: true` → répétés sur chaque page en cas de débordement.
- Tableau `wrap: false` par ligne → pas de split au milieu d'une ligne.
- Produits longs → tronqués à 40 chars + `…` (`truncateName` dans `CreditNotePdf.ts`).

## Assets

Dossier : `client/api/_lib/pdf/assets/`

- **Logo officiel** : à fournir par design (`fruitstock-logo.png` ou `.svg`). Tant que l'asset n'est pas disponible, le composant rend un stub `View` carré orange avec un `F` blanc (suffisant pour passer les tests structurels AC #9). **Remplacer** par :

  ```ts
  import { Image } from '@react-pdf/renderer'
  // …
  h(Image, { src: '/api/_lib/pdf/assets/fruitstock-logo.png', style: { width: 40, height: 40 } })
  ```

  (ou embed data-URL pour éviter un fetch HTTP serverless).

- **Charte visuelle Excel historique** : non versionnée (fichier maîtrisé par pôle compta). Si dérive constatée entre ce PDF et le PDF Excel legacy, réviser les valeurs ci-dessus et re-générer le bench AC #11.

## Tests visuels

- AC #8.5 (Story 4.5) : émettre un avoir réel via preview Vercel, télécharger le PDF généré OneDrive, comparer à l'Excel legacy (équipe compta). Divergences = ouvrir issue Story 4.5 follow-up.
- AC #11 bench : `client/scripts/bench/pdf-generation.ts` — p95 cible < 2s, p99 < 10s.
