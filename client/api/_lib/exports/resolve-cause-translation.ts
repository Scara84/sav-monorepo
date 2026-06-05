import { normalizeCauseKey } from '../../../src/shared/validation/normalize-cause-key'

/**
 * Résout la traduction ES d'une cause SAV depuis le sous-map `sav_cause` de
 * `ctx.translations`, par CLÉ NORMALISÉE.
 *
 * FR12 fix (Sprint Change Proposal 2026-06-05) : la cause stockée est un SLUG
 * (`abime`) alors que les clés du map sont des LIBELLÉS (`Abîmé`). Un lookup
 * direct `list[causeRaw]` ne matche jamais → fallback FR silencieux. On scanne
 * donc le sous-map (≤10 entrées) en comparant les clés normalisées des deux côtés.
 *
 * Retourne `undefined` si aucune correspondance OU si la traduction est vide/null
 * → le resolver appelant déclenche le fallback FR + warning `export.translation.missing`.
 *
 * Source UNIQUE partagée entre `rufinoConfig` et `martinezConfig` (anti-divergence —
 * tout futur export fournisseur DOIT passer par ce helper, cf. guard de test).
 */
export function resolveTranslatedCause(
  list: Record<string, string> | undefined,
  causeRaw: string,
): string | undefined {
  if (!list) return undefined
  const causeKey = normalizeCauseKey(causeRaw)
  for (const [value, es] of Object.entries(list)) {
    if (normalizeCauseKey(value) === causeKey) {
      return es === '' ? undefined : es
    }
  }
  return undefined
}
