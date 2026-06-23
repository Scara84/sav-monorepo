/**
 * Normalise une "cause" SAV (motif) en clé de jointure stable, indépendante du
 * format de stockage, pour la rapprocher de `validation_lists(list_code='sav_cause')`.
 *
 * Pourquoi : la capture self-service stocke la cause sous forme de SLUG
 * (`abime` / `manquant` / `autre` — minuscule, sans accent) dans
 * `sav_lines.request_reason` ET `validation_messages[{kind:'cause', text}]`,
 * alors que `validation_lists.value` est le LIBELLÉ FR (`Abîmé` / `Manquant` /
 * `Autre`…). Le JOIN `cause = value` ne matche donc jamais → traduction motif
 * toujours `'otro'` (reconcile Epic 8) / fallback FR silencieux (export Epic 5).
 *
 * Cette normalisation est IDEMPOTENTE et symétrique :
 *   normalizeCauseKey('Abîmé') === normalizeCauseKey('abime') === 'abime'
 *   normalizeCauseKey('Manquant') === normalizeCauseKey('manquant') === 'manquant'
 * → on l'applique des DEUX côtés (clé du référentiel ET cause stockée) pour
 * obtenir une jointure robuste, que la DB stocke un slug ou un libellé.
 *
 * Source unique partagée entre :
 *   - reconcile-supplier-claim (Epic 8 / Story 8.2) — `buildMotifMap` + lookup pur
 *   - export fournisseur Rufino (Epic 5) — résolveur colonne CAUSA
 *
 * Cf. Sprint Change Proposal 2026-06-05 (Option B), bug FR12.
 *
 * ⚠️ LIMITE DU CONTRAT (DEF-1) : NFD ne décompose PAS les ligatures (`Œ`, `Æ`, `ß`).
 * Si un futur motif sav_cause contient une ligature (libellé `Œuf`, slug `oeuf`), la
 * normalisation ne les rapprochera pas → retour à `'otro'` silencieux. Les 10 motifs
 * actuels n'en contiennent aucune. Pour un référentiel canonique sans cette limite,
 * basculer en Option A (colonne `validation_lists.code` slug explicite).
 */
export function normalizeCauseKey(raw: string): string {
  // L-3 : garde défensif — un appel hors-contrat (null/undefined par un futur consommateur)
  // ne doit pas crasher en runtime (le typage TS ne protège que la compilation).
  if (typeof raw !== 'string') return ''
  return raw
    .normalize('NFD') // décompose les caractères accentués (é → e + diacritique combinant)
    .replace(/\p{Diacritic}/gu, '') // retire les diacritiques combinants (U+0300–U+036F)
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ') // normalise les espaces internes
}
