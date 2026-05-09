# CONVENTION-PARIS-FIXE — Affichage des dates/heures en back-office

**Contexte V1 Fruitstock** : mono-tenant, opérateurs Paris uniquement.

Toute UI back-office qui formate une date/heure stockée en UTC **DOIT** passer `timeZone: 'Europe/Paris'` explicitement à `toLocaleString('fr-FR', { ..., timeZone: 'Europe/Paris' })` — ne jamais s'appuyer sur la TZ implicite du browser (fragile en CI / staging cloud / ops en déplacement).

Si V2 introduit des opérateurs multi-fuseaux → extraire `userTimezone` en config + composable `useFormattedDateTime(iso, userTz)`.

Note : `<input type="datetime-local">` returns browser-local time (no TZ suffix). The display layer enforces Paris TZ but the input itself remains in the browser's local TZ. V1 Fruitstock = Paris-only ops, accepted. V2 multi-tenant requires explicit TZ picker or backend resolution.
