import { logger } from '../logger'

/**
 * Story 4.4 / 4.5 — interface stable pour l'enqueue asynchrone de la génération
 * PDF d'un avoir (bon SAV). Le handler d'émission 4.4 appelle cette fonction
 * en `fire-and-forget` juste avant de renvoyer la réponse 200 à l'opérateur.
 *
 * Contrat :
 *   - Signature stable (ne jamais casser sans migration 4.4 / 4.5 conjointe).
 *   - La fonction ne doit JAMAIS throw de manière synchrone — les erreurs
 *     remontent via le retour (Promise rejetée) et le handler 4.4 capture
 *     `.catch()` pour logger sans bloquer le 200.
 *   - `pdf_web_url` reste NULL en DB tant que la génération n'a pas abouti ;
 *     l'UI polle `GET /api/credit-notes/:number/pdf` (202 pending → 302 OK).
 *
 * Implémentation V1 (cette story) :
 *   Stub qui logue un TODO Story 4.5 et résout immédiatement. Le numéro
 *   d'avoir est bien émis, seul le PDF est absent — mode dégradé documenté
 *   (story 4.4, AC #7). La Story 4.5 remplace ce corps par la vraie pipeline
 *   (render @react-pdf → upload OneDrive → UPDATE credit_notes.pdf_web_url).
 */
export interface GenerateCreditNotePdfArgs {
  credit_note_id: number
  sav_id: number
  request_id: string
}

export async function generateCreditNotePdfAsync(args: GenerateCreditNotePdfArgs): Promise<void> {
  // Story 4.5 remplacera ce corps. Aujourd'hui : log + no-op.
  logger.info('credit_note.pdf.enqueue_stub', {
    requestId: args.request_id,
    creditNoteId: args.credit_note_id,
    savId: args.sav_id,
    stub: true,
  })
}
