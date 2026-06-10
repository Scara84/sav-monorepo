# Story V1.10 : Email client de clôture SAV avec bon SAV (avoir) PDF

Status: ready-for-dev

<!-- Source : UAT bout-en-bout 2026-06-10 (SAV-2026-00003, AV-2026-00003) —
     deferred-work.md « FEATURE : email client de fin de process avec bon SAV PDF ».
     Candidate V1 arbitrée par le PO (Antho) : étape manquante du process. -->

## Story

As an **adhérent dont le SAV vient d'être clôturé**,
I want **recevoir un email de confirmation de fin de SAV contenant mon bon SAV (avoir) en PDF**,
so that **j'ai une trace comptable directe sans devoir me connecter à l'espace adhérent**.

## Acceptance Criteria

1. **AC#1 — Enrichissement email `sav_closed`** : quand un SAV passe au statut
   `closed` ET qu'au moins un avoir (credit_note) avec PDF généré existe pour ce
   SAV, l'email `sav_closed` envoyé via l'outbox contient le PDF de l'avoir en
   **pièce jointe** (nom de fichier = celui généré par `buildPdfFilename.ts`).
2. **AC#2 — Fallback lien** : si le téléchargement du PDF échoue au moment de
   l'envoi (OneDrive indisponible, `pdf_web_url` null, génération encore en
   cours), l'email part **quand même** avec le contenu actuel + un lien vers
   l'espace adhérent (`{APP_BASE_URL}/monespace/sav/:id`) et un libellé
   « votre bon SAV est disponible dans votre espace ». L'échec de PJ ne doit
   JAMAIS bloquer ni faire échouer l'envoi (NFR-REL).
3. **AC#3 — Infra attachments SMTP** : `SmtpMailInput` (smtp.ts) supporte un
   champ optionnel `attachments?: Array<{ filename: string; content: Buffer }>`
   passé tel quel à nodemailer. Var absente du champ → comportement strictement
   inchangé (rétrocompat tous call-sites existants).
4. **AC#4 — Récupération du PDF côté sender** : le runner outbox
   (`retry-emails.ts`) résout le PDF au moment de l'envoi : credit_notes du
   sav_id → la plus récente avec PDF dispo → download bytes via Graph
   (réutiliser le client `onedrive-ts.ts` / pattern du
   `pdf-redirect-handler.ts`), cap taille 10 MB (au-delà → fallback lien AC#2).
5. **AC#5 — Opt-out respecté** : le gate existant
   `notification_prefs.status_updates` (kind member) reste inchangé — un membre
   opt-out ne reçoit ni email ni PDF. Aucun envoi direct dans le handler de
   transition : tout passe par l'outbox (pattern 6.6, retry inclus).
6. **AC#6 — Multi-avoirs** : si plusieurs avoirs existent pour le SAV (cas
   regeneration_of), seul le PDF de l'avoir **actif le plus récent** est joint.
7. **AC#7 — Redirect test** : `EMAIL_REDIRECT_ALL_TO` s'applique inchangé (le
   redirect opère dans sendMail, en aval de la PJ) — vérifiable en preview.
8. **AC#8 — Tests** : unit sender (PJ jointe, fallback échec download, cap
   taille, opt-out, multi-avoirs) + template (mention bon SAV) ; aucun test
   existant 6.6 ne casse (66 tests retry-emails + templates).

## Tasks / Subtasks

- [ ] Task 1 (AC#3) : étendre `SmtpMailInput` + `sendMail` avec `attachments`
      optionnel (mapping direct nodemailer), tests unitaires smtp.spec.ts
      (rétrocompat sans attachments + 1 PJ Buffer).
- [ ] Task 2 (AC#4, AC#6) : module pur `resolveSavClosedAttachment(savId)` dans
      `api/_lib/emails/` — SELECT credit_notes (pdf dispo, plus récent), download
      Graph bytes, retourne `{ filename, content } | null`. Logger warn structuré
      si échec (jamais throw vers le runner).
- [ ] Task 3 (AC#1, AC#2, AC#5) : intégrer dans `retry-emails.ts` — uniquement
      pour `kind === 'sav_closed'` ; PJ si résolue, sinon enrichir template_data
      avec `pdfFallback: true` ; template `sav-closed.ts` : paragraphe bon SAV
      (PJ jointe vs lien espace adhérent).
- [ ] Task 4 (AC#8) : tests ATDD avant implémentation (pattern projet) ; rejouer
      suite 6.6 complète + typecheck.
- [ ] Task 5 : UAT réel preview (clôturer un SAV de test, vérifier réception
      sur EMAIL_REDIRECT_ALL_TO avec PJ).

## Dev Notes

- **Pas de migration** : on réutilise le kind `sav_closed` existant (whitelist
  CHECK Story 6.1 + `kinds.ts` inchangés). Ne PAS créer de nouveau kind — la
  whitelist DB devrait être migrée et la valeur n'apporterait rien.
- **Résolution PJ à l'envoi, pas à l'enqueue** : l'enqueue `sav_closed` a lieu
  dans la transition (productivity-handlers.ts) possiblement AVANT la fin de la
  génération asynchrone du PDF (generate-credit-note-pdf.ts, retry 3×). Résoudre
  au send (cron retry-emails) maximise la probabilité que le PDF existe ; le
  fallback AC#2 couvre le reste. NE PAS bloquer/attendre la génération.
- **Download Graph** : `pdf-redirect-handler.ts` montre le pattern d'accès au
  fichier OneDrive d'un avoir (item id / web url). Préférer le download par
  item-id Graph (auth app) — le `pdf_web_url` SharePoint peut exiger une session.
- **Taille** : PDF avoir ≈ 50-200 KB (1 page) ; cap 10 MB purement défensif.
- **NFR-REL (pattern 6.6)** : le runner marque sent/failed par ligne ; un échec
  de PJ ne doit pas compter comme échec d'envoi (fallback = envoi nominal).
- **Anti-spam** : la PJ PDF + sujet préfixé `[TEST→…]` en période de redirect
  peut accentuer le scoring spam — sans impact prod (pas de redirect en prod).

### Project Structure Notes

- `client/api/_lib/clients/smtp.ts` — extension input (S-07 tests existants).
- `client/api/_lib/emails/transactional/sav-closed.ts` — template.
- `client/api/_lib/cron-runners/retry-emails.ts` — intégration sender.
- Nouveau : `client/api/_lib/emails/sav-closed-attachment.ts` (module pur).
- Tests : `client/tests/unit/api/cron/retry-emails.spec.ts` (étendre),
  `client/tests/unit/api/_lib/clients/smtp.spec.ts`,
  `client/tests/unit/api/emails/` (template).

### References

- [Source: deferred-work.md#UAT process complet — FEATURE email bon SAV (2026-06-10)]
- [Source: client/api/_lib/emails/transactional/kinds.ts — MEMBER_KINDS/whitelist]
- [Source: client/api/_lib/cron-runners/retry-emails.ts — runner outbox + opt-out]
- [Source: client/api/_lib/pdf/generate-credit-note-pdf.ts — génération async + OneDrive]
- [Source: client/api/_lib/credit-notes/pdf-redirect-handler.ts — accès fichier avoir]
- [Source: stories 4.4/4.5 (émission + PDF), 6.4 (download espace adhérent), 6.6 (outbox)]

## Dev Agent Record

### Agent Model Used

### Debug Log References

### Completion Notes List

### File List
