---
title: 'Recherche SAV par adhérent et commande groupe'
type: 'bugfix'
created: '2026-10-27'
status: 'done'
baseline_commit: '8729b68b2556d3d082e2419a091c179227cfef8e'
context:
  - '{project-root}/.bmad/low-cost-mode.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Le champ de recherche de la liste SAV transmet bien `q`, mais le backend ne l'applique qu'au `tsvector` de `sav`, composé de la référence, de la facture, des notes internes et des tags. Les prénom/nom de l'adhérent et `sav.metadata.invoice_special_mention` n'y figurent pas : « Nathan » ne retrouve donc pas les SAV de Nathan Serre, et la colonne « Groupe » affiche le groupe organisationnel au lieu de la « Commande groupe », par exemple `479_26S41_64_2`.

**Approach:** Étendre la recherche globale existante en conservant un seul `q` grâce à une RPC SQL dédiée, autorisée par Antho le 27/10/2026. La base recherche directement dans les champs SAV, la commande groupe et le prénom/nom de l'adhérent, tout en conservant filtres, count et pagination ; la commande groupe est aussi exposée sous un champ explicite du contrat liste et affichée dans la colonne « Groupe ».

## Boundaries & Constraints

**Always:** Conserver le debounce, la synchronisation URL et le paramètre `q` actuels. Préserver les filtres combinés, le tri, le count et la pagination cursor. Paramétrer la RPC et traiter littéralement les caractères spéciaux des recherches `ILIKE`. Ne renvoyer au frontend que la commande groupe projetée, jamais l'objet `metadata` complet. Une recherche reste insensible à la casse et combine en OR les sources textuelles, puis en AND les autres filtres actifs.

**Ask First:** Toute dénormalisation du nom adhérent dans `sav`, modification de la source Pennylane, ou tentative de reconstruire les commandes groupe historiques absentes des métadonnées. La RPC SQL dédiée à cette recherche est explicitement autorisée.

**Never:** Ajouter un second champ de recherche, renommer la colonne demandée « Groupe », changer la signification de `sav.group_id`, ou refactoriser les écrans SAV hors de cette liste.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Recherche prénom/nom | `q=Nathan`; un adhérent a `first_name=Nathan` | Les SAV liés à cet adhérent sont retournés, avec les autres filtres appliqués | Une erreur RPC produit la réponse serveur journalisée standard, sans résultat partiel |
| Recherche commande groupe | `q=479_26S41_64_2`; la valeur existe dans `metadata.invoice_special_mention` | Le SAV est trouvé par la recherche globale | Les caractères `_`, `%`, `\`, virgules et parenthèses ne modifient pas la syntaxe du filtre |
| Affichage commande groupe | Une ligne possède `invoice_special_mention=479_26S41_64_2` | La cellule « Groupe » affiche exactement `479_26S41_64_2` | Si la valeur est absente ou vide, afficher `—` |
| Compatibilité recherche | `q` correspond à une référence, facture, note ou tag existant | Le comportement actuel reste fonctionnel | Aucun match renvoie une liste vide et un count à zéro |

</frozen-after-approval>

## Code Map

- `client/supabase/migrations/` -- accueillera la RPC `search_sav_list`, seul point de composition recherche/filtres/count/cursor.
- `client/api/_lib/sav/list-handler.ts` -- valide la requête HTTP, appelle la RPC et projette le contrat `SavListItem`.
- `client/tests/unit/api/sav/list.spec.ts` -- mock Supabase et couverture des arguments/résultats/erreurs de la RPC.
- `client/supabase/tests/rpc/` -- tests SQL réels de recherche, filtres, count et pagination.
- `client/supabase/tests/security/` -- assertions de droits et `search_path` de la nouvelle RPC.
- `client/src/features/back-office/composables/useSavList.ts` -- contrat liste frontend et sérialisation de `q`.
- `client/src/features/back-office/views/SavListView.vue` -- champ de recherche et cellule « Groupe ».
- `client/tests/unit/features/back-office/SavListView.spec.ts` -- rendu et interactions de la liste.

## Tasks & Acceptance

**Execution:**
- [x] `client/supabase/migrations/` -- créer `search_sav_list`, RPC SQL `STABLE SECURITY DEFINER` réservée au `service_role`, qui joint adhérents/groupes/opérateurs et applique recherche OR, filtres AND, count exact avant cursor, tri `(received_at,id) DESC` et `limit+1`.
- [x] `client/supabase/tests/rpc/search_sav_list.test.sql` et `client/supabase/tests/security/search_sav_list_security.test.sql` -- couvrir prénom, nom, nom complet, commande groupe littérale, recherche historique, filtres combinés, count, cursor, ordre et ACL/search_path.
- [x] `client/api/_lib/sav/list-handler.ts` -- remplacer la construction PostgREST par l'appel RPC, mapper tous les paramètres validés, reconstruire le contrat imbriqué et conserver logs/erreurs/cursor opaque.
- [x] `client/tests/unit/api/sav/list.spec.ts` -- mocker la RPC et couvrir paramètres, filtres combinés, résultat vide, count/cursor, erreur et projection sans fuite de metadata.
- [x] `client/src/features/back-office/composables/useSavList.ts` et `client/src/features/back-office/views/SavListView.vue` -- typer/afficher `invoiceSpecialMention` et expliciter le placeholder de recherche.
- [x] `client/tests/unit/features/back-office/SavListView.spec.ts` -- vérifier le rendu de la commande groupe et le fallback `—`.

**Acceptance Criteria:**
- Given des SAV liés à plusieurs adhérents, when l'opérateur recherche un prénom ou un nom partiel, then seuls les SAV dont l'adhérent correspond, ainsi que les éventuels matchs des autres sources globales, sont retournés.
- Given une commande groupe présente dans les métadonnées, when l'opérateur recherche son code, then le SAV apparaît et le même code est visible dans la colonne « Groupe ».
- Given un statut, une date ou un autre filtre actif, when une recherche adhérent ou commande groupe est lancée, then la recherche reste AND-jointe à ces filtres et la pagination/count restent cohérents.
- Given les recherches historiques par référence, facture, note ou tag, when les tests ciblés sont exécutés, then aucune régression n'est observée.

## Spec Change Log

- 2026-10-27 — La première revue a démontré que la pré-requête d'IDs adhérents pouvait être tronquée par PostgREST et dépasser la taille maximale d'une requête. Antho a autorisé une RPC dédiée ; le plan remplace donc la liste d'IDs par une recherche jointe atomique. KEEP : un seul champ `q`, contrat HTTP existant, colonne « Groupe », filtres/count/cursor et projection explicite de la commande groupe.

## Design Notes

La RPC évite toute liste intermédiaire d'IDs et compose les prédicats dans PostgreSQL. Elle utilise le `tsvector sav.search` existant pour référence/facture/notes/tags et des `ILIKE` littéraux échappés pour prénom, nom, nom complet et `metadata.invoice_special_mention`. `COUNT(*) OVER()` est calculé sur l'ensemble filtré avant d'appliquer le cursor ; la RPC retourne des lignes plates, ensuite remises au contrat imbriqué par le handler. Les anciennes lignes sans commande groupe restent à `—`.

## Verification

**Commands:**
- `cd client && npm test -- --run tests/unit/api/sav/list.spec.ts tests/unit/features/back-office/SavListView.spec.ts` -- tous les scénarios ciblés passent.
- `cd client && npm run typecheck` -- aucune erreur TypeScript/Vue.
- `cd client && npm run audit:schema` -- migrations et contraintes restent cohérentes.
- `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f client/supabase/tests/rpc/search_sav_list.test.sql` puis le test sécurité -- scénarios SQL et permissions passent quand la base locale est disponible.

## Suggested Review Order

**Orchestration API**

- Transforme les filtres validés en un appel RPC atomique et typé.
  [`list-handler.ts:220`](../../client/api/_lib/sav/list-handler.ts#L220)

- Préserve le count lorsqu'un ancien cursor produit une page vide.
  [`list-handler.ts:249`](../../client/api/_lib/sav/list-handler.ts#L249)

**Recherche SQL et sécurité**

- Centralise jointures, recherche, filtres, tri et pagination dans PostgreSQL.
  [`20261027120000_search_sav_list.sql:4`](../../client/supabase/migrations/20261027120000_search_sav_list.sql#L4)

- Calcule le count exact avant l'application du cursor.
  [`20261027120000_search_sav_list.sql:106`](../../client/supabase/migrations/20261027120000_search_sav_list.sql#L106)

- Ferme le search path de la fonction SECURITY DEFINER.
  [`20261027120000_search_sav_list.sql:46`](../../client/supabase/migrations/20261027120000_search_sav_list.sql#L46)

- Réserve explicitement l'exécution au service role backend.
  [`20261027120000_search_sav_list.sql:133`](../../client/supabase/migrations/20261027120000_search_sav_list.sql#L133)

**Contrat et affichage**

- Ajoute la commande groupe au contrat liste frontend.
  [`useSavList.ts:23`](../../client/src/features/back-office/composables/useSavList.ts#L23)

- Rend la commande groupe avec fallback robuste dans la colonne existante.
  [`SavListView.vue:528`](../../client/src/features/back-office/views/SavListView.vue#L528)

**Preuves automatisées**

- Couvre noms partiels, nom complet et recherche insensible à la casse.
  [`search_sav_list.test.sql:75`](../../client/supabase/tests/rpc/search_sav_list.test.sql#L75)

- Verrouille les caractères littéraux et leurs valeurs leurres.
  [`search_sav_list.test.sql:118`](../../client/supabase/tests/rpc/search_sav_list.test.sql#L118)

- Vérifie le tie-break ID puis le cursor à timestamp identique.
  [`search_sav_list.test.sql:231`](../../client/supabase/tests/rpc/search_sav_list.test.sql#L231)

- Vérifie SECURITY DEFINER, search path et ACL de la RPC.
  [`search_sav_list_security.test.sql:5`](../../client/supabase/tests/security/search_sav_list_security.test.sql#L5)

- Couvre le fallback count d'une page cursored vide.
  [`list.spec.ts:169`](../../client/tests/unit/api/sav/list.spec.ts#L169)

