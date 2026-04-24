# Story 4.5: Template PDF charte Fruitstock + génération serverless

Status: ready-for-dev

<!-- Render PDF bon SAV via @react-pdf/renderer (déjà installé, pur JS sans
     Chromium). Template fidèle à la charte Fruitstock (logo orange, SIRET,
     mentions légales, tableau lignes détaillées, totaux HT/remise/TVA/TTC).
     Upload OneDrive + update credit_notes.pdf_web_url. Appelé en async depuis
     Story 4.4 (enqueue) + expose un endpoint re-download déjà posé par 4.4.
     Target perf : < 2s p95, < 10s p99 (marge Vercel timeout 10s). -->

## Story

As an operator,
I want un bon SAV PDF généré automatiquement après émission d'un avoir — avec la charte Fruitstock (logo orange, raison sociale, SIRET), toutes les mentions légales, le tableau détaillé des lignes (produit, qté, unité, prix HT, coefficient, montant), les totaux (HT, remise responsable, TVA, TTC) et un nom de fichier `<AV-YYYY-NNNNN> <nom-client>.pdf`,
so that le document émis est légalement conforme (mentions TVA, identification fournisseur), reconnaissable par les adhérents (charte visuelle fidèle au template Excel historique), et stocké sur OneDrive accessible à l'adhérent via `webUrl`.

## Acceptance Criteria

### AC #1 — Composant React PDF `CreditNotePdf.tsx`

**Given** le fichier `client/api/_lib/pdf/CreditNotePdf.tsx` créé par cette story
**When** j'inspecte ses exports
**Then** il expose :

```tsx
import type { FC } from 'react'
import { Document } from '@react-pdf/renderer'

export interface CreditNotePdfProps {
  creditNote: {
    id: bigint
    number: bigint
    number_formatted: string        // 'AV-2026-00042'
    bon_type: 'AVOIR' | 'VIREMENT BANCAIRE' | 'PAYPAL'
    total_ht_cents: number
    discount_cents: number
    vat_cents: number
    total_ttc_cents: number
    issued_at: string               // ISO timestamp
  }
  sav: {
    reference: string               // '2026-0042'
    invoice_ref: string | null
    invoice_fdp_cents: number | null
  }
  member: {
    first_name: string | null
    last_name: string
    email: string
    phone: string | null            // masqué si non consenti RGPD
    address_line1: string | null
    address_line2: string | null
    postal_code: string | null
    city: string | null
  }
  group: { name: string } | null
  lines: Array<{
    line_number: number
    product_code_snapshot: string
    product_name_snapshot: string
    qty_requested: number
    unit_requested: 'kg' | 'piece' | 'liter'
    qty_invoiced: number | null
    unit_invoiced: 'kg' | 'piece' | 'liter' | null
    unit_price_ht_cents: number | null
    credit_coefficient: number
    credit_coefficient_label: string | null   // ex: 'TOTAL 100%'
    credit_amount_cents: number | null
    validation_message: string | null
  }>
  company: {                         // constantes chargées depuis settings
    legal_name: string               // 'Fruitstock SAS'
    siret: string                    // '12345678901234'
    tva_intra: string                // 'FR12345678901'
    address_line1: string
    postal_code: string
    city: string
    phone: string
    email: string
  }
  is_group_manager: boolean          // affichage badge responsable
}

export const CreditNotePdf: FC<CreditNotePdfProps>
```

**And** le composant est **pur** (no fetch, no async) — consommation via `renderToBuffer(<CreditNotePdf {...props} />)` [Source: @react-pdf/renderer v4.5.1 API]
**And** le composant utilise des `StyleSheet.create()` inline (pas de fichier `.css` externe — @react-pdf n'en consomme pas)
**And** la charte visuelle respecte :
  - En-tête : logo Fruitstock (orange `#F57C00` ou code exact fourni assets), raison sociale + SIRET + TVA intra + adresse à droite, taille 9-10pt
  - Titre : « BON SAV » ou « AVOIR » (selon `bon_type`) en haut centre, 18pt bold
  - Bloc références : `N° Avoir: AV-YYYY-NNNNN`, `Date: DD/MM/YYYY`, `Client: <prénom nom>`, `Groupe: <nom>`, `Facture liée: <invoice_ref>` (si présent)
  - Tableau lignes : colonnes `N° | Code | Libellé | Qté demandée | Unité | Qté facturée | Prix HT | Coef | Montant TTC`
  - Totaux bas-droite : `Sous-total HT: X €` + `Remise 4% (responsable): X €` (si applicable) + `TVA (5,5 %): X €` + `**Total TTC: X €**` (gras)
  - Footer : mention légale TVA ( « TVA sur marge » ou « TVA collectée » selon cas — PRD §F&A), SIRET, n° téléphone support, n° de page `Page N / M`
  - Marges : 15mm top/bottom, 12mm left/right (A4 portrait 210×297mm)

### AC #2 — Format des montants et dates

**Given** les helpers formatage
**When** le composant render des montants / dates
**Then**
- Montants : `Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' })` → `1 234,56 €` (espace insécable milliers, virgule décimale)
- Si montant = 0 : afficher `0,00 €` (pas `—`)
- Si `credit_amount_cents IS NULL` (ligne non-ok) : afficher `—` dans la colonne Montant + une note en bas `⚠ Lignes non-comptabilisées : <N>`. **Décision V1** : ne pas inclure ces lignes dans le PDF émis (car AC #4 de 4.4 gate à toutes lignes ok). **Fallback** : si une ligne slippe malgré tout, le PDF la rend avec `—` mais n'affecte pas les totaux.
- Dates : `DD/MM/YYYY` (locale fr-FR), pas d'heure sur le PDF émis (1 PDF par jour comptable logiquement)
- Nom fichier généré : `${number_formatted} ${member.last_name}${member.first_name ? ' ' + member.first_name[0] + '.' : ''}.pdf` — ex: `AV-2026-00042 Dupont J.pdf`. Sanitizer : remplace `[^A-Za-z0-9 \-\.]` par `_`, tronqué à 80 chars max (compatibilité OneDrive / Windows).

### AC #3 — Constantes `company` chargées depuis `settings`

**Given** les clés settings versionnées créées par cette story
**When** on charge la société émettrice
**Then** une migration `20260428120000_settings_company_keys.sql` ajoute en seed (idempotent via `ON CONFLICT DO NOTHING`) :

```sql
INSERT INTO settings (key, value, valid_from) VALUES
  ('company.legal_name',      to_jsonb('Fruitstock SAS'::text),              now()),
  ('company.siret',           to_jsonb('<à renseigner cutover>'::text),      now()),
  ('company.tva_intra',       to_jsonb('<à renseigner cutover>'::text),      now()),
  ('company.address_line1',   to_jsonb('<à renseigner cutover>'::text),      now()),
  ('company.postal_code',     to_jsonb('<à renseigner cutover>'::text),      now()),
  ('company.city',            to_jsonb('<à renseigner cutover>'::text),      now()),
  ('company.phone',           to_jsonb('<à renseigner cutover>'::text),      now()),
  ('company.email',           to_jsonb('<à renseigner cutover>'::text),      now()),
  ('company.legal_mentions_short', to_jsonb('TVA acquittée sur les encaissements'::text), now())
ON CONFLICT (key, valid_from) DO NOTHING;
```

**And** les valeurs placeholder `<à renseigner cutover>` sont **explicitement documentées** : le cutover Epic 7 exécutera un script `scripts/cutover/seed-company-info.sql` qui `UPDATE settings SET value = ... WHERE key = 'company.siret'` avec les valeurs légales réelles.
**And** le handler serverless de génération PDF charge ces 9 clés via `settingsResolver.ts` (réutilise 4.2) — résolution au moment de la génération, pas snapshot stocké dans `credit_notes` (si Fruitstock change d'adresse, les anciens PDF déjà générés restent figés tels qu'ils étaient au moment de l'émission ; les futurs PDF reflètent la nouvelle adresse — comportement acceptable V1, audit d'historique OK via audit_trail).
**And** si une clé `company.*` manque (résolution `null`) → le handler **refuse** la génération et log `PDF_GENERATION_FAILED|missing_company_key=<key>`, le credit_note reste `pdf_web_url IS NULL` (surfacé par endpoint 4.4 `/api/credit-notes/:n/pdf` → 202 pending, alerte Epic 7 à terme).

### AC #4 — Fonction asynchrone `generateCreditNotePdfAsync`

**Given** le fichier `client/api/_lib/pdf/generate-credit-note-pdf.ts`
**When** cette story crée la fonction
**Then** le contrat exporté correspond **strictement** à celui stipulé par Story 4.4 AC #7 :

```ts
export interface GenerateCreditNotePdfArgs {
  credit_note_id: bigint
  sav_id: bigint
  request_id: string
}
export async function generateCreditNotePdfAsync(args: GenerateCreditNotePdfArgs): Promise<void>
```

**And** le déroulé interne de la fonction est :
1. Charger `credit_notes` + `sav` + `member` + `group` + `sav_lines` + `settings.company.*` (en parallèle quand possible, `Promise.all`)
2. Charger `isGroupManager` (même logique Story 4.3/4.4)
3. Construire les `props` du composant `CreditNotePdf`
4. Générer le buffer PDF via `const buffer = await renderToBuffer(<CreditNotePdf {...props} />)` [Source: @react-pdf/renderer server-side API]
5. Sanitizer le nom de fichier (AC #2)
6. Upload OneDrive via `uploadCreditNotePdf(buffer, filename, { folder })` — helper étendu depuis `api/_lib/onedrive-ts.ts` existant (Epic 1 / Story 2.4)
7. Update `credit_notes` : `UPDATE credit_notes SET pdf_onedrive_item_id = :itemId, pdf_web_url = :webUrl WHERE id = :credit_note_id` (via supabaseAdmin, bypass RLS)
8. Log `PDF_GENERATED|credit_note_id=...|request_id=...|duration_ms=...`

**And** si l'étape 6 échoue (OneDrive API 500 / timeout) → retry × 3 avec backoff exponentiel (1s, 2s, 4s) — **deferred W29** : queue persistante avec retry illimité si la logique Epic 7 email_outbox est réutilisable ; V1 = 3 retries in-memory puis log `PDF_UPLOAD_FAILED` + alerte
**And** si l'étape 4 échoue (render PDF) → log `PDF_RENDER_FAILED|error=...` + stack, credit_note garde `pdf_web_url IS NULL` (pas de retry — bug template à fixer manuellement, pas transitoire)
**And** la fonction est **idempotente** : appelée 2× avec mêmes args → second appel détecte `pdf_web_url IS NOT NULL` et retourne immédiatement sans régénérer (protection contre double-enqueue Story 4.4 race)

### AC #5 — Dossier OneDrive structuré

**Given** l'upload OneDrive
**When** le helper calcule le path
**Then** la structure cible est :
```
/SAV_PDF/<YYYY>/<MM>/<filename>.pdf
```
ex: `/SAV_PDF/2026/04/AV-2026-00042 Dupont J.pdf`

**And** le helper appelle `ensureFolder('/SAV_PDF/<year>/<month>')` avant upload (pattern Epic 1 ou à ajouter) — si le dossier existe déjà, `Ensure` est idempotent
**And** le `webUrl` retourné par Graph API (champ `webUrl` du DriveItem) est stocké dans `credit_notes.pdf_web_url`
**And** le `id` OneDrive du DriveItem est stocké dans `credit_notes.pdf_onedrive_item_id` (pour suppression RGPD future Epic 7)
**And** le path est configurable via `settings.onedrive.pdf_folder_root` (défaut `/SAV_PDF`) — 1 clé de plus à ajouter dans la migration AC #3

### AC #6 — Mécanisme async (décision V1)

**Given** la contrainte Vercel Hobby (fonctions serverless, pas de worker persistant, pas de queue Redis bundled)
**When** la fonction `generateCreditNotePdfAsync` est appelée par le handler 4.4
**Then** la **décision V1** est : **appel direct `await` mais détaché via `waitUntil` Vercel Edge** si disponible, ou Node.js `setImmediate(...)` + try/catch pour détacher de la boucle de requête principale.

Concrètement :
```ts
// Dans emit-handler.ts (Story 4.4)
import { waitUntil } from '@vercel/functions'   // disponible en serverless Node >= 18
// ...
// Enqueue sans bloquer la réponse HTTP
waitUntil(generateCreditNotePdfAsync({ credit_note_id, sav_id, request_id }))
```

**And** si `@vercel/functions.waitUntil` n'est pas disponible (test env / local dev) → fallback :
```ts
void generateCreditNotePdfAsync(args).catch(err => logger.error('PDF_ASYNC_FAILED', { err }))
```
(le handler retourne sa response HTTP, la promise continue à tourner — acceptable pour Node standalone)
**And** la génération PDF tourne dans la **même lambda** que l'émission d'avoir. Conséquence : la timeout Vercel Hobby 10s s'applique au total (émission + PDF). Budget : émission RPC ≤ 1s, render PDF ≤ 2s, upload OneDrive ≤ 2s, total < 5s → marge confortable.
**And** si V1.1 dépasse les 10s en charge → migration vers Vercel Cron + queue DB (table `pdf_generation_queue` + polling — déféré W30)
**And** documenter V1 décision dans `docs/integration-architecture.md` section « Génération PDF »

### AC #7 — Endpoint `GET /api/credit-notes/:number/pdf` (implémenté par 4.4 AC #8)

**Given** l'endpoint déjà défini par Story 4.4 AC #8
**When** cette story 4.5 vérifie la cohérence
**Then** le handler `pdf-redirect-handler.ts` :
- Retourne **302** + `Location: <pdf_web_url>` si `pdf_web_url IS NOT NULL`
- Retourne **202** `{ code: 'PDF_PENDING', retry_after_seconds: 5 }` si `IS NULL` et `issued_at < 5 minutes` (génération en cours)
- Retourne **500** `{ code: 'PDF_GENERATION_STALE', credit_note_number_formatted: '...' }` si `IS NULL` et `issued_at >= 5 minutes` (génération échouée durablement — opérateur doit relancer manuellement via endpoint 4.5 AC #8)
- Cas absent → **404** `CREDIT_NOTE_NOT_FOUND`

**And** cette story étend 4.4 AC #8 avec le cas `PDF_GENERATION_STALE` (ajout logique minor côté handler déjà livré)

### AC #8 — Endpoint `POST /api/credit-notes/:number/regenerate-pdf` (stale recovery)

**Given** un credit_note avec `pdf_web_url IS NULL` et `issued_at >= 5 minutes`
**When** l'opérateur appelle `POST /api/credit-notes/:number/regenerate-pdf`
**Then** le handler `regenerate-pdf-handler.ts` (nouveau, co-localisé dans `credit-notes/`) :
- Valide auth opérateur
- Vérifie `credit_notes.pdf_web_url IS NULL` — si déjà présent → **409** `PDF_ALREADY_GENERATED`
- Appelle `generateCreditNotePdfAsync` en **synchrone** (`await` — l'opérateur attend la réponse)
- Retourne **200** `{ pdf_web_url: 'https://...' }` OR **500** `PDF_GENERATION_FAILED|<cause>`

**And** ce handler reste derrière le dispatcher `credit-notes.ts` (Story 4.4)
**And** la regénération est **throttlée** : max 1 appel toutes les 30s par credit_note (via `withRateLimit` sur clé `credit_note_id`)

### AC #9 — Tests PDF rendering `CreditNotePdf.test.tsx` : ≥ 8 cas

**Given** le fichier `client/api/_lib/pdf/CreditNotePdf.test.tsx`
**When** `npm test -- --run CreditNotePdf` s'exécute
**Then** les tests suivants passent (via `@react-pdf/renderer` `renderToBuffer` + `pdf-parse` pour extraire le texte) :

1. **Structure complète happy path** : 3 lignes ok, responsable → buffer non vide, > 1 Ko, contient texte `AV-2026-00042`, `Dupont`, `Fruitstock SAS`, `Total TTC`, `TVA`
2. **Bloc remise visible** : `is_group_manager=true` → texte `Remise 4%` présent
3. **Bloc remise masqué** : `is_group_manager=false` → texte `Remise` absent du PDF
4. **bon_type='AVOIR'** → titre « AVOIR »
5. **bon_type='VIREMENT BANCAIRE'** → titre « BON SAV » (ou équivalent — à définir avec designer : recommandation : `VIREMENT BANCAIRE` reste titré « BON SAV » pour différencier de l'AVOIR fiscal)
6. **Nom fichier** : function `buildPdfFilename(creditNote, member)` retourne `AV-2026-00042 Dupont J.pdf` (+ test sanitizer : `member.last_name='D/upont'` → `D_upont`)
7. **Montants fr-FR** : `total_ttc_cents=123456` → texte contient `1 234,56 €` (espace insécable, virgule décimale)
8. **Multi-ligne footer** : 3 mentions légales distinctes → texte contient les 3
9. **Colonnes tableau** : 5 lignes → 5 lignes de texte sous l'en-tête `Produit | Qté | ...`
10. **Bench 50 rendus** : `for (let i=0;i<50;i++) await renderToBuffer(...)` → durée totale loguée (indicatif, pas d'assertion strict p95 V1 — test `skip`-able, vise surveillance)

**And** couverture fonctionnelle ≥ 70 % (seuil plus bas que la business logic : le JSX est déjà largement « visuel »)

### AC #10 — Tests handler `generate-credit-note-pdf.test.ts` : ≥ 8 cas

**Given** le fichier `client/api/_lib/pdf/generate-credit-note-pdf.test.ts`
**When** `npm test` exécute
**Then**
1. **Happy path E2E** : RPC appelée (Story 4.4), puis `generateCreditNotePdfAsync` invoqué → mock `renderToBuffer` retourne Buffer → mock OneDrive upload retourne `{ webUrl, itemId }` → assert UPDATE `credit_notes` correct
2. **OneDrive 500 → retry × 3** : mock échoue 2× puis succeed → UPDATE finalisé, 3 logs `PDF_UPLOAD_RETRY`
3. **OneDrive 500 permanent (3 échecs)** → log `PDF_UPLOAD_FAILED`, `credit_notes.pdf_web_url` reste NULL
4. **Render fail** : `renderToBuffer` lève → log `PDF_RENDER_FAILED`, credit_note pdf_web_url inchangé, **pas de retry** (code bug)
5. **Idempotence** : appeler 2× avec même `credit_note_id` → le 2nd détecte `pdf_web_url IS NOT NULL` et retourne sans régénérer (log `PDF_ALREADY_GENERATED_SKIP`)
6. **Clé settings.company.siret manquante** → abort, log `PDF_GENERATION_FAILED|missing_company_key=siret`, `pdf_web_url` reste NULL
7. **Regenerate endpoint** : `POST /api/credit-notes/:n/regenerate-pdf` avec pdf_web_url=null → handler appelle la fonction synchrone, retourne 200 + webUrl
8. **Regenerate endpoint idempotent** : pdf_web_url déjà présent → 409 `PDF_ALREADY_GENERATED`

### AC #11 — Performance p95 < 2s (benchmark continu)

**Given** un bench script `scripts/bench/pdf-generation.ts` créé par cette story
**When** je l'exécute contre la DB préview Supabase + mock OneDrive local
**Then**
- 50 générations consécutives → log p50, p95, p99 en console
- **Target V1** : p95 < 2s, p99 < 10s (marge Vercel)
- Si p95 > 2s (seuil de warning) → print `⚠ PDF p95 = Xms > 2s — investigate` (warning, pas d'échec CI V1)
- **Pas d'intégration CI** V1 — script lancé manuellement en pré-merge et shadow run Epic 7

**And** le bench n'appelle pas vraiment OneDrive (mock upload retourne Buffer size) pour isoler la mesure render PDF pure
**And** script ≤ 80 lignes, utilise `@react-pdf/renderer` + fixtures existantes

### AC #12 — Documentation charte + assets

**Given** la charte visuelle Fruitstock
**When** cette story est livrée
**Then** un dossier `client/api/_lib/pdf/assets/` contient :
- `fruitstock-logo.png` (ou .jpg) : le logo officiel (à fournir par design ou extraire du template Excel legacy)
- `charte-fruitstock.md` : 20-30 lignes décrivant la palette (orange primaire `#F57C00` ou exact, noir secondaire, gris ligne), la typographie (famille par défaut `@react-pdf/renderer` si OK, sinon embed `Roboto` ou `Open Sans` via `Font.register`), les règles de placement (logo 40×40 en haut-gauche, etc.)

**And** si le logo n'est pas disponible au moment du dev → **stub SVG** `<rect fill="#F57C00"/>` + commentaire `// TODO: replace with real logo, tracking ticket ...` — le PDF passe les tests structurels sans blocage
**And** le `.md` charte est **ajouté à `docs/`** (pas seulement en interne `_lib/`) pour que design/PM puisse le réviser

## Tasks / Subtasks

- [ ] **Task 1 — Migration settings `company.*` (AC #3)**
  - [ ] 1.1 Créer `client/supabase/migrations/20260428120000_settings_company_keys.sql` avec 9 clés + placeholders
  - [ ] 1.2 Ajouter 1 clé `onedrive.pdf_folder_root` = `/SAV_PDF` default
  - [ ] 1.3 Documenter TODO cutover Epic 7 dans header migration

- [ ] **Task 2 — Composant React PDF (AC #1, #2, #12)**
  - [ ] 2.1 Créer `client/api/_lib/pdf/CreditNotePdf.tsx` avec props types + JSX
  - [ ] 2.2 Créer `client/api/_lib/pdf/buildPdfFilename.ts` + `formatEurPdf.ts` helpers
  - [ ] 2.3 Créer `client/api/_lib/pdf/assets/` + stub logo + charte md
  - [ ] 2.4 `StyleSheet.create()` avec palette Fruitstock

- [ ] **Task 3 — Fonction async `generateCreditNotePdfAsync` (AC #4, #5)**
  - [ ] 3.1 Créer `client/api/_lib/pdf/generate-credit-note-pdf.ts`
  - [ ] 3.2 Logique load → render → upload → update
  - [ ] 3.3 Étendre `api/_lib/onedrive-ts.ts` avec `uploadCreditNotePdf(buffer, filename, { folder })` (si pas déjà en Epic 2)
  - [ ] 3.4 Helper `ensureOneDriveFolder(path)` (idempotent)
  - [ ] 3.5 Retry × 3 backoff exponentiel pour OneDrive
  - [ ] 3.6 Idempotence check (`pdf_web_url IS NOT NULL` → skip)

- [ ] **Task 4 — Intégration Story 4.4 (AC #6)**
  - [ ] 4.1 Ajouter import `generateCreditNotePdfAsync` dans `emit-handler.ts` (Story 4.4 stub)
  - [ ] 4.2 Enqueue via `waitUntil(...)` + fallback `void ... .catch(...)`
  - [ ] 4.3 Décision V1 documentée dans `docs/integration-architecture.md`

- [ ] **Task 5 — Endpoint regenerate (AC #7, #8)**
  - [ ] 5.1 Étendre `pdf-redirect-handler.ts` avec cas `PDF_GENERATION_STALE`
  - [ ] 5.2 Créer `client/api/_lib/credit-notes/regenerate-pdf-handler.ts`
  - [ ] 5.3 Router branche POST `/:number/regenerate-pdf` dans `credit-notes.ts` dispatcher
  - [ ] 5.4 RateLimit 1/30s par credit_note

- [ ] **Task 6 — Tests (AC #9, #10)**
  - [ ] 6.1 `CreditNotePdf.test.tsx` ≥ 8 cas (pdf-parse pour extraction text)
  - [ ] 6.2 `generate-credit-note-pdf.test.ts` ≥ 8 cas (mock supabase + mock OneDrive)
  - [ ] 6.3 `pdf-redirect-handler.test.ts` étendu (+2 cas : stale + 202 pending)
  - [ ] 6.4 `regenerate-pdf-handler.test.ts` ≥ 4 cas

- [ ] **Task 7 — Bench (AC #11)**
  - [ ] 7.1 Créer `scripts/bench/pdf-generation.ts`
  - [ ] 7.2 Script ≤ 80 lignes, 50 rendus, log p50/p95/p99
  - [ ] 7.3 README bench dans `scripts/bench/README.md` (courte doc)

- [ ] **Task 8 — CI + Non-regression**
  - [ ] 8.1 `npm test` tous verts (+25 tests env.)
  - [ ] 8.2 `npm run typecheck` 0 erreur (attention JSX inside .tsx serveur — vérifier tsconfig `jsx` + serveur runtime)
  - [ ] 8.3 `npm run lint` 0 erreur
  - [ ] 8.4 `npm run build` : taille bundle 459 KB ± 5 % (le `@react-pdf/renderer` ne doit PAS être inclus dans le bundle client — vérifier tree-shaking, côté serveur uniquement)
  - [ ] 8.5 Preview Vercel : émettre un avoir réel via UI (Story 4.4), observer le PDF généré via OneDrive shared link → valider rendu visuel manuel

## Dev Notes

### Dépendances avec autres stories

- **Prérequis done** : 4.1 (credit_notes + RPC), 4.2 (moteur TS), 4.0 (sav_lines)
- **Prérequis partiel** : 4.4 (endpoint emit) — **ordre de merge recommandé : 4.5 avant 4.4** pour que 4.4 puisse invoquer vraiment `generateCreditNotePdfAsync`. Sinon 4.4 shippe avec stub + 4.5 remplace le stub.
- **Bloque** : Story 6.4 (adhérent télécharge PDF via self-service — réutilise endpoint redirect)
- **Non-bloquant** : 4.6 (load test) — le load test n'exerce pas la génération PDF (hors scope), uniquement la séquence RPC

### Décisions V1

1. **@react-pdf/renderer pur JS** (déjà v4.5.1 installé) vs Chromium/Puppeteer : choix V1 JS pur → pas de runtime binaire lourd, scalable serverless Vercel, limite = CSS/layout un peu moins riches que HTML→PDF. Le template Excel Fruitstock est tabulaire → OK.
2. **Génération sync dans lambda émission** vs queue async : V1 sync via `waitUntil` pour simplicité. V1.1 migration queue si p95 dépasse 5s (W30).
3. **Path OneDrive `/SAV_PDF/YYYY/MM/filename.pdf`** : structure traçable par période, compatible rétention comptable 10 ans. PDF orphelin (credit_note supprimé) → à nettoyer via Epic 7 anonymisation.
4. **Logo asset** : si non disponible au dev → stub color block + ticket de suivi. Ne pas bloquer la story pour un asset.
5. **Font embedding** : par défaut `@react-pdf/renderer` Helvetica/Times built-in. Si design demande Roboto/Open Sans → `Font.register` + asset .ttf livré dans `assets/`. V1 = built-in OK.

### Contrat de compatibilité ascendante

| Champ `credit_notes` | Story 4.1 | Story 4.4 | Story 4.5 |
|----------------------|-----------|-----------|-----------|
| `number`, `number_formatted` | ✅ GENERATED | lit | lit |
| `pdf_onedrive_item_id`, `pdf_web_url` | ✅ nullable | (vide post-émission) | ✅ UPDATE |
| `issued_at`, `issued_by_operator_id` | ✅ set par RPC | — | lit pour header PDF |
| `total_*_cents` | ✅ set par RPC | calcule amont | lit pour totaux PDF |

Aucune migration schéma requise en 4.5 — seulement la migration settings (AC #3).

### Source Tree Components à toucher

| Fichier | Action |
|---------|--------|
| `client/supabase/migrations/20260428120000_settings_company_keys.sql` | **créer** |
| `client/api/_lib/pdf/CreditNotePdf.tsx` | **créer** |
| `client/api/_lib/pdf/CreditNotePdf.test.tsx` | **créer** |
| `client/api/_lib/pdf/buildPdfFilename.ts` | **créer** |
| `client/api/_lib/pdf/formatEurPdf.ts` | **créer** |
| `client/api/_lib/pdf/generate-credit-note-pdf.ts` | **créer** |
| `client/api/_lib/pdf/generate-credit-note-pdf.test.ts` | **créer** |
| `client/api/_lib/pdf/assets/fruitstock-logo.{png,svg}` | **créer** (stub possible) |
| `docs/charte-fruitstock-pdf.md` | **créer** |
| `client/api/_lib/onedrive-ts.ts` | **modifier** (helper `uploadCreditNotePdf` + `ensureFolder` si manquant) |
| `client/api/_lib/credit-notes/regenerate-pdf-handler.ts` | **créer** |
| `client/api/_lib/credit-notes/regenerate-pdf-handler.test.ts` | **créer** |
| `client/api/_lib/credit-notes/pdf-redirect-handler.ts` | **modifier** (cas stale) |
| `client/api/credit-notes.ts` | **modifier** (branche POST regenerate) |
| `client/api/_lib/credit-notes/emit-handler.ts` | **modifier** (remplacer stub par vrai import) |
| `scripts/bench/pdf-generation.ts` | **créer** |
| `scripts/bench/README.md` | **créer** |
| `docs/integration-architecture.md` | **modifier** (section Génération PDF) |

### Gotchas @react-pdf/renderer

- **Pas de `position: absolute`** stable cross-version — utiliser `flexbox` uniquement
- **Texte long sans espaces** → overflow, clip — pour `product_name_snapshot`, limiter à 40 chars + `…`
- **Serveur Node ≥ 18** avec JSX runtime — vérifier `tsconfig.json` a `"jsx": "react-jsx"` pour le dossier `api/_lib/pdf/` (ou isoler tsconfig local)
- **Embed fonts coût** : 200-500 Ko par font TTF ajoutés au bundle serveur. Éviter sauf besoin charte.

### Testing standards summary

- `pdf-parse` lib (à ajouter dev dep si absent) pour extraire le texte du Buffer et asserter contenus
- Mock `@microsoft/microsoft-graph-client` ou helper `onedrive-ts.ts` via vi.mock pour isoler upload dans tests
- Mock `supabaseAdmin` via pattern Epic 3 (import alias)

### Project Structure Notes

- Nouveau dossier `client/api/_lib/pdf/` : cohérent avec `_lib/sav/`, `_lib/credit-notes/`, `_lib/business/` — regroupement par domaine fonctionnel
- Assets binaires dans `_lib/pdf/assets/` (vs `public/` client) : justifié car consommés server-side
- Budget Serverless Functions Vercel : pas d'ajout fonction (regenerate sous dispatcher `credit-notes.ts`)

### References

- [Source: _bmad-output/planning-artifacts/epics.md:874-892] — Story 4.5 AC BDD originelle (charte, p95, re-download)
- [Source: _bmad-output/planning-artifacts/prd.md] — §PDF bon SAV (mentions légales, charte) + §F&A (mentions TVA)
- [Source: _bmad-output/planning-artifacts/architecture.md:101-103,171-180] — Pattern PDF serverless + async enqueue
- [Source: client/supabase/migrations/20260425120000_credit_notes_sequence.sql:75-77] — colonnes `pdf_onedrive_item_id`, `pdf_web_url` déjà présentes
- [Source: _bmad-output/implementation-artifacts/4-4-emission-atomique-n-avoir-bon-sav.md] — contrat `GenerateCreditNotePdfArgs` + endpoint redirect baseline
- [Source: _bmad-output/implementation-artifacts/4-2-moteur-calculs-metier-typescript-triggers-miroirs-fixture-excel.md] — `settingsResolver` pour clés `company.*`
- [Source: client/package.json] — `@react-pdf/renderer ^4.5.1` présent, pas d'ajout de dep (sauf `pdf-parse` dev)
- [Source: client/api/_lib/onedrive-ts.ts] — helper base à étendre (upload + ensureFolder)
- [Source: _bmad-output/implementation-artifacts/deferred-work.md] — W27 TVA multi-taux détail footer (différé V1.1), W29 queue persistante PDF (différé V1.1), W30 migration vers Vercel Cron + queue DB si p95 > 5s

## Dev Agent Record

### Agent Model Used

{{agent_model_name_version}}

### Debug Log References

### Completion Notes List

### File List
