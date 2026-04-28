import { ensureRequestId } from '../request-id'
import { sendError } from '../errors'
import { listSupplierConfigs } from './supplier-configs'
import type { ApiHandler } from '../types'

/**
 * Story 5.6 AC #5 — `GET /api/exports/supplier/config-list`.
 *
 * Retourne la liste des fournisseurs supportés (code, label, language),
 * dérivée dynamiquement du registry `supplier-configs.ts`. Permet à l'UI
 * (modal export + filtre historique) de peupler ses select-options sans
 * hardcoder les codes ; l'ajout d'un fournisseur N+1 (Alvarez, …) ne
 * nécessitera plus aucune modification UI.
 *
 * Auth : `withAuth({ types: ['operator'] })` appliqué au niveau router
 * (`pilotage.ts`) — toutes les routes Pilotage exigent un opérateur. La
 * vérification redondante ci-dessous est volontaire (CR Story 5.6 P8) :
 * défense en profondeur si ce handler est un jour mis derrière un router
 * différent qui n'applique pas le wrapping `withAuth`. Coût : ~3 lignes,
 * pas de double-roundtrip (le user est déjà dans `req.user`).
 *
 * Pas de pagination ni de filtre — la liste est petite (≤ ~10 entrées)
 * et stable. Cache HTTP géré côté UI via `useSupplierExport` (un fetch
 * par mount de modal — tolérable).
 */
export const exportsConfigListHandler: ApiHandler = async (req, res) => {
  const requestId = ensureRequestId(req)
  const user = req.user
  // CR Story 5.6 P8 — défense en profondeur (cf. JSDoc ci-dessus).
  if (!user || user.type !== 'operator') {
    sendError(res, 'FORBIDDEN', 'Session opérateur requise', requestId)
    return
  }

  const suppliers = listSupplierConfigs()
  res.status(200).json({ data: { suppliers } })
}
