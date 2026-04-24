/**
 * Story 4.5 — wrapper `waitUntil` pour la génération PDF asynchrone.
 *
 * Vercel serverless Node ≥ 18 expose `@vercel/functions.waitUntil(promise)` :
 * la fonction continue à tourner **après** le retour de la réponse HTTP,
 * jusqu'à résolution de la promise OU timeout lambda (10s Hobby). Sans ça,
 * V8 peut freezer la lambda dès le retour du handler.
 *
 * En environnement non-Vercel (tests, dev local Node standalone) ou si la
 * dépendance n'est pas installée (cas V1), on dégrade proprement :
 * `void promise.catch(...)` — le handler retourne, la promise continue à
 * tourner dans l'event loop du process. Acceptable tant que la promise ne
 * throw pas (elle doit avoir son propre `.catch` ou être no-throw).
 *
 * Contrat : `waitUntilOrVoid(p)` ne retourne rien — side-effect uniquement.
 * Toute rejection **doit** être capturée par l'appelant AVANT de passer
 * ici (pattern emit-handler : `generateCreditNotePdfAsync(...).catch(...)`).
 *
 * V1.1 migration possible : installer `@vercel/functions` en prod pour
 * activer le vrai `waitUntil`. Ce fichier détecte sa présence dynamiquement.
 */
import { logger } from '../logger'

type WaitUntilFn = (p: Promise<unknown>) => void

let cachedFn: WaitUntilFn | null = null

function resolveWaitUntil(): WaitUntilFn {
  if (cachedFn !== null) return cachedFn
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('@vercel/functions') as { waitUntil?: WaitUntilFn }
    if (typeof mod.waitUntil === 'function') {
      cachedFn = mod.waitUntil
      logger.debug('wait_until.vercel_functions_loaded')
      return cachedFn
    }
  } catch {
    // Module absent — fallback.
  }
  cachedFn = fallback
  return cachedFn
}

function fallback(p: Promise<unknown>): void {
  // Le caller s'est déjà chargé du .catch() — mais on protège une seconde
  // fois pour ne jamais laisser un unhandled rejection crasher Node ≥ 15.
  void p.catch((err) => {
    logger.error('wait_until.fallback_unhandled_rejection', {
      error: err instanceof Error ? err.message : String(err),
    })
  })
}

export function waitUntilOrVoid(p: Promise<unknown>): void {
  resolveWaitUntil()(p)
}

/** Reset cache uniquement pour les tests (mock dynamique de @vercel/functions). */
export function __resetWaitUntilCacheForTests(): void {
  cachedFn = null
}
