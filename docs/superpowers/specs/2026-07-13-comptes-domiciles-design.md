# Comptes utilisateurs & domiciles partagés — Design

**Date** : 2026-07-13
**Statut** : validé en brainstorming (Ernest), en cours d'implémentation sur `feature/comptes-domiciles`
**Périmètre** : Phase 1 (comptes + domiciles + météo par lieu + migration + RLS) **et** Phase 2 (invitations par lien web), livrées ensemble.

---

## 1. Intention

Faire passer le Carnet de pluie d'un **jardin unique en dur** (Anières, RLS ouverte, pas de login) à une **PWA multi-domiciles avec comptes**, du niveau de MowTimer (qui est lui-même une PWA, pas une app native) :

- **Compte** email + mot de passe.
- **Plusieurs domiciles** par compte (ex. Anières / Île de Ré), chacun avec **adresse → coordonnées → météo et reco propres**.
- **Sélecteur** pour jongler entre domiciles.
- **Domiciles partagés** : plusieurs comptes voient les mêmes données d'arrosage (père/fils aujourd'hui, cousin demain).
- **Invitation par lien web** en libre-service (révocable, expirable), sans infra email.
- **Migration sans perte** : Anières devient le 1er domicile, tout l'historique est préservé, père et fils en restent membres.

### Contraintes fortes

- **App vivante** : utilisée quotidiennement par Ernest + son père ; le calcul repose sur l'historique 7 j. La bascule ne doit rien perdre ni casser.
- **Vanilla, offline-first, PWA GitHub Pages** : on garde HTML/CSS/JS sans framework. Seule exception assumée : la brique **auth** (voir §4).
- **Sécurité** : on remplace les policies RLS ouvertes par un vrai cloisonnement par appartenance.
- **Pas de sur-ingénierie** : on capitalise sur l'existant (Supabase, `engine.js` pur, `store.js`).

---

## 2. Décisions (issues du brainstorming)

| Sujet | Décision |
|---|---|
| Ambition | PWA aboutie type MowTimer (pas de natif / stores). |
| Découpage | Phase 1 **+** Phase 2 ensemble. |
| Migration | **Tout préserver** : Anières = 1er domicile, historique rattaché. |
| Localisation | **Adresse tapée** (géocodage) **+** bouton « ma position » (GPS navigateur). |
| Invitation | **Lien web** uniquement (révocable/expirable), self-service. |
| Auth | **`@supabase/auth-js` vendorisé** pour la session ; accès données reste vanilla (`store.js`). |

---

## 3. Modèle de données

### Nouvelles tables

```
domiciles
  id           uuid pk (gen_random_uuid)
  nom          text            -- « Anières », « Île de Ré »
  adresse      text            -- label lisible affiché
  lat          double precision
  lon          double precision
  timezone     text            -- ex. Europe/Zurich (renvoyé par Open-Meteo)
  objectif_mm  numeric  default 28     -- réglages FUSIONNÉS dans le domicile
  debit_mm_h   numeric  default 27
  kc           numeric  default 0.8
  objectif_manuel boolean default false
  owner_id     uuid  references auth.users(id)   -- créateur
  created_at   timestamptz default now()

domicile_members
  domicile_id  uuid references domiciles(id) on delete cascade
  user_id      uuid references auth.users(id) on delete cascade
  role         text check (role in ('owner','admin','member')) default 'member'
  prenom       text            -- nom affiché de CE membre dans CE domicile (ex. « Papa »)
  created_at   timestamptz default now()
  unique (domicile_id, user_id)

invitations
  token        uuid pk default gen_random_uuid()
  domicile_id  uuid references domiciles(id) on delete cascade
  role         text default 'member' check (role in ('member','admin'))
  created_by   uuid references auth.users(id) default auth.uid()
  expires_at   timestamptz default now() + interval '7 days'
  revoked      boolean default false
  created_at   timestamptz default now()
```

### Tables existantes — ajout de `domicile_id`

`arrosages`, `contraintes`, `push_subscriptions` reçoivent une colonne
`domicile_id uuid references domiciles(id) on delete cascade`.

- `arrosages` : la clé primaire passe de `jour` seul à **`(domicile_id, jour)`** (un jour par domicile).
- `reglages` (table globale `id=1`) est **absorbée dans `domiciles`** : plus de ligne unique globale. Les colonnes `objectif_mm/debit_mm_h/kc/objectif_manuel` vivent sur le domicile. On garde l'ancienne table le temps de la migration puis on la retire.
- `push_subscriptions` : garde `endpoint` en clé (un device) et gagne `user_id` + `domicile_id` (pour savoir quels domiciles notifier sur quel appareil). Un device peut avoir plusieurs lignes (une par domicile suivi) — décision Phase 3, pour l'instant `domicile_id` nullable.

### Anti-récursion RLS

Toutes les policies s'appuient sur une fonction `SECURITY DEFINER` dans un schéma `private`
(pattern officiel Supabase, `search_path=''` figé) pour éviter la récursion infinie
`domiciles ↔ domicile_members` :

```sql
create schema if not exists private;
create or replace function private.is_member(_d uuid) returns boolean
  language sql security definer set search_path = '' stable as $$
  select exists (select 1 from public.domicile_members m
    where m.domicile_id = _d and m.user_id = (select auth.uid())); $$;
create or replace function private.is_admin(_d uuid) returns boolean
  language sql security definer set search_path = '' stable as $$
  select exists (select 1 from public.domicile_members m
    where m.domicile_id = _d and m.user_id = (select auth.uid())
      and m.role in ('owner','admin')); $$;
```

Policies : `select/insert/update/delete` des tables de données `using (private.is_member(domicile_id))`.
`domiciles` : select si membre, update/delete si admin, insert si `owner_id = auth.uid()`.
`invitations` : tout réservé aux admins ; l'invité n'y accède **jamais** en direct.

### Invitation — RPC `SECURITY DEFINER`

L'invité connecté appelle `public.accept_invitation(_token uuid)` qui, après contrôle
(existe / non révoquée / non expirée, `for update` anti-concurrence), l'insère dans
`domicile_members` (`on conflict do nothing`, idempotent). L'invité n'a aucun droit
d'écriture direct sur `domicile_members`. Le SQL complet est dans la migration.

---

## 4. Authentification

**Choix** : `@supabase/auth-js` (librairie officielle GoTrue) **vendorisée en un seul fichier ESM**
(`vendor/auth-js.js`, produite par esbuild, committée), précachée par le service worker → offline préservé,
zéro dépendance runtime chargée d'un CDN. Le reste (accès données) reste vanilla.

Justification : la gestion de session (rotation du refresh token, expiration, verrou multi-onglets)
est le point où le code maison accumule des bugs de sécurité subtils. On délègue **juste ça** à
la lib éprouvée ; on ne tire pas tout `supabase-js` (postgrest/realtime inutiles).

### Module `auth.js`

Encapsule un `GoTrueClient` unique :

```js
const auth = new GoTrueClient({
  url: SUPA_URL + '/auth/v1',
  headers: { apikey: SUPA_KEY },      // /auth/v1 exige apikey
  storageKey: 'cdp-auth',
  autoRefreshToken: true, persistSession: true, detectSessionInUrl: true,
  flowType: 'pkce',
});
```

Expose : `signUp`, `signIn`, `signOut`, `resetPassword`, `getSession`, `onChange(cb)`,
et surtout `accessToken()` (jeton courant, pour `store.js`).

### En-têtes (nouveau format de clés Supabase `sb_publishable_` / `sb_secret_`)

| Cas | `apikey` | `Authorization` |
|---|---|---|
| Utilisateur connecté (RLS via `auth.uid()`) | `sb_publishable_…` | `Bearer <access_token>` |
| Serveur / GitHub Actions (bypass RLS) | `sb_secret_…` | *(rien — la clé secrète ne va PAS en Bearer)* |

⚠️ Piège vérifié : avec les nouvelles clés, mettre la clé en `Authorization: Bearer` fait **rejeter**
la requête. `store.js` mettra le **JWT de session** en Bearer, la clé publishable en `apikey`.

### Confirmation d'email

SMTP par défaut Supabase = ~2 messages/h vers les seules adresses de l'équipe → inutilisable pour de
vrais proches. **Décision** : désactiver « Confirm email » (Dashboard) pour le cercle privé ; l'accès
aux **données** reste verrouillé par l'appartenance (un compte sans domicile ne voit rien). L'onboarding
réel se fait par le **lien d'invitation**. Reset password : best-effort, à activer plus tard avec un SMTP custom.

---

## 5. Météo par domicile (géocodage)

### `weather.js` — paramétrage

`fetchWeatherData({ lat, lon, tz })` remplace les constantes en dur (Anières = défauts pour
rétro-compat). Construit les URLs Open-Meteo avec les coordonnées du domicile courant.
`timezone=auto` demandé à Open-Meteo (renvoie `timezone`/`utc_offset_seconds`) → propre en multi-fuseaux.

### `geocode.js` — nouveau module

- **Adresse tapée** → primaire **Open-Meteo Geocoding** (`geocoding-api.open-meteo.com/v1/search`,
  CORS `*`, même fournisseur, renvoie le fuseau ; recherche niveau ville/village — suffisant vu la
  grille météo ~2 km). Fallback **Nominatim** (`/search`) pour une précision rue, **au submit
  uniquement** (jamais d'autocomplete — interdit par la politique OSM), Referer = domaine GitHub Pages,
  attribution « © OpenStreetMap » affichée.
- **Ma position** → `navigator.geolocation.getCurrentPosition({ enableHighAccuracy:true, timeout:10000,
  maximumAge:0 })`, gère les codes 1/2/3, puis reverse geocoding **Nominatim `/reverse`** pour un label
  lisible.
- **Stockage** : `lat`/`lon` arrondis à **4 décimales** (~11 m, largement assez), `label`, `timezone`.

---

## 6. Modifications côté client

### Nouvel état & namespacing

`app.js` gagne un état `currentDomicileId` et une liste `domiciles`. **Tous les caches localStorage**
(`cp.weather`, `cp.arrosages`, `cp.reglages`, `cp.contraintes`) sont **namespacés par domicile**
(`cp.<domicileId>.weather`, …) pour ne pas mélanger les maisons. `cp.prenom` disparaît au profit du
`prenom` par membre. Le choix du domicile courant est mémorisé (`cp.currentDomicile`).

### `store.js` — signature

- `headers()` devient `async` (ou reçoit le token) : `Authorization: Bearer <accessToken>` depuis `auth.js`,
  `apikey` = publishable.
- Chaque fonction data reçoit `domicileId` : `getArrosages(domicileId)`, `upsertArrosage({domicileId, jour, minutes, prenom})`, `getReglages`→remplacé par lecture du domicile, `patchReglages`→`patchDomicile(id, patch)`, `getContraintes(domicileId)`, `addContrainte({domicileId,…})`, `purgeBefore(domicileId, date)`, etc.
- Nouvelles : `getMyDomiciles()`, `createDomicile({nom, adresse, lat, lon, timezone})`, `createInvitation(domicileId, role)`, `acceptInvitation(token)` (RPC), `listInvitations(domicileId)`, `revokeInvitation(token)`, `getMembers(domicileId)`.

### UI (`index.html` + `styles.css`)

- **Écran login/inscription** : overlay plein écran `#auth` calqué sur le pattern `#onboard`
  (`hidden`, slides). Email, mot de passe, bascule connexion/inscription, mot de passe oublié.
- **Sélecteur de domicile** dans le `<header>` (remplace `· Anières` en dur) : `<select>` + entrée
  « ➕ Ajouter un domicile ».
- **Écran/section « Ajouter un domicile »** : nom, champ adresse (bouton Rechercher), bouton
  « 📍 Ma position », aperçu carte-less (label + coordonnées), réglages objectif/débit/Kc.
- **Section « Partage »** (dans Réglages du domicile) : bouton « Générer un lien d'invitation »
  → affiche l'URL à copier/partager ; liste des membres ; liste des invitations actives (révoquer).
- **Page `rejoindre`** : au chargement, si `?token=…` présent, après login/inscription, appelle
  `acceptInvitation(token)` puis redirige vers l'app sur ce domicile.

### `sw.js`

Bump `VERSION` (`cp-v8`) et ajouter au précache : `./auth.js`, `./vendor/auth-js.js`, `./geocode.js`,
`./domicile.js` (le module d'état domicile) et tout nouveau JS. `supabase.co` reste exclu du cache
(les appels `/auth/v1` passent au réseau — correct).

### `scripts/morning-push.mjs`

- Passe à la **clé secrète** (`SB_SECRET` en secret GitHub Actions, comme `VAPID_PRIVATE_KEY`) pour
  lire toutes les données malgré la RLS fermée → `store.js` doit accepter des headers alternatifs
  (clé + pas de Bearer).
- **Boucle par domicile** : pour chaque domicile, fetch météo (lat/lon), données filtrées,
  `planNotification()` (inchangé, pur), puis notifier les abonnements de ce domicile.

### `supabase/functions/chat/index.ts`

Le `systemPrompt` reçoit le **nom du domicile + les prénoms des membres** depuis le contexte client
(au lieu d'« Anières / Ernest et son père » en dur). Le client fournit déjà le contexte via `chatContext()`.

---

## 7. Migration (exécutée AVEC Ernest, cutover coordonné)

Le code ci-dessus vit sur une branche ; la bascule live est une étape courte à faire ensemble car
elle exige des comptes réels et casserait l'app du père si faite unilatéralement.

**Checklist de bascule** (~15 min) :

1. **Comptes** : Ernest crée son compte (email/mdp) ; son père crée le sien (ou Ernest crée les deux
   et communique le mot de passe). Récupérer les deux `user_id`.
2. **Migration SQL** (`supabase/migrations/0001_comptes_domiciles.sql`) exécutée dans le SQL Editor :
   crée les tables, les fonctions, les policies, la RPC ; crée le **domicile « Anières »**
   (lat 46.2777, lon 6.2234, Europe/Zurich, réglages actuels) ; ajoute `domicile_id` aux tables ;
   **backfill** tous les `arrosages`/`contraintes` existants avec l'id d'Anières ; insère
   Ernest (owner) + père (member) dans `domicile_members`.
3. **RLS** : activer les policies fermées, retirer les policies ouvertes.
4. **Config** : `SB_SECRET` ajouté aux secrets GitHub Actions ; « Confirm email » désactivé au dashboard.
5. **Déploiement** : merge de la branche → GitHub Pages sert la nouvelle version ; bump SW force la maj.
6. **Vérif** : les deux comptes se connectent, voient Anières + l'historique, une écriture de l'un est
   vue par l'autre. Ajouter un 2e domicile de test. Générer un lien d'invitation et le tester.

**Rollback** : si un problème survient, revert du merge (retour à l'ancien HTML/JS) + réactivation des
policies ouvertes. Les données ne sont pas détruites (colonnes ajoutées, pas supprimées).

---

## 8. Tests

- **`engine.test.mjs`** : inchangé (moteur pur, non impacté).
- **`weather` (nouveau)** : `fetchWeatherData({lat,lon})` construit la bonne URL ; défauts = Anières.
- **`geocode` (nouveau)** : parsing des réponses Open-Meteo / Nominatim (mockées), arrondi 4 décimales,
  gestion d'erreurs geolocation.
- **`auth` (nouveau)** : logique de session mockée (token présent/absent → headers corrects), sans réseau.
- **`store` (nouveau, unitaire)** : construction des requêtes avec `domicile_id`, headers Bearer JWT.
- **`supabase.test.mjs`** (intégration) : étendu pour login → JWT → isolation entre domiciles
  (un user ne lit pas le `domicile_id` d'un autre), rejet non-authentifié. **Ne peut tourner
  qu'après la migration** (base réelle migrée).
- **Playwright** : smoke test local — écran login s'affiche, inscription, sélecteur de domicile,
  ajout d'un domicile via « ma position » (mock), génération d'un lien d'invitation.

---

## 9. Découpage d'implémentation (ordre)

1. `supabase/migrations/0001_comptes_domiciles.sql` — schéma + RLS + RPC (fichier, non exécuté).
2. `weather.js` — paramétrage lat/lon/tz (+ test), rétro-compatible.
3. `config.js` — endpoints auth, note clé secrète serveur.
4. `vendor/auth-js.js` (bundle esbuild) + `auth.js` (module session).
5. `store.js` — headers JWT + `domicile_id` sur toutes les fonctions + nouvelles fonctions.
6. `geocode.js` — adresse + position + reverse.
7. `domicile.js` — état domicile courant, liste, namespacing localStorage.
8. `app.js` — gate d'auth, sélecteur, ajout de domicile, partage, câblage.
9. `index.html` + `styles.css` — écrans login / domicile / partage.
10. `sw.js` — bump version + nouveaux fichiers.
11. `scripts/morning-push.mjs` — clé secrète + boucle domiciles.
12. `supabase/functions/chat/index.ts` — prompt paramétré.
13. Tests + Playwright + itérations.

---

## 10. Ce qui reste hors périmètre (Phase 3)

- Notifications push finement multi-domiciles (un device, plusieurs maisons, préférences par maison).
- Gestion de compte avancée (changer email, supprimer compte/RGPD, avatars).
- Empaquetage store (TWA/wrapper) — non nécessaire (PWA suffit).
- SMTP custom (confirmation email, reset password fiables).
