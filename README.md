# Carnet de pluie 🌧️💧

Dashboard d'arrosage intelligent pour un jardin arrosé **à la main** à Anières (GE).
Il répond à une seule question, en grand : **faut-il arroser aujourd'hui, et combien de minutes ?**
Conçu pour deux arroseurs (père + fils) partageant le même jardin.

- Météo réelle : **MétéoSuisse ICON CH2 (2 km)** via Open-Meteo (sans clé, CORS ouvert).
- Décision : un moteur à **5 règles** (heuristiques horticoles), source unique `engine.js`.
- Vanilla : HTML/CSS/JS, **aucun framework, aucune librairie**.

## État d'avancement

- [x] **Étape 1 — Cœur local** : page + fetch météo + moteur 5 règles. App utilisable en local.
- [x] **Étape 2 — Historique partagé (Supabase)** : base commune père/fils, cache offline, échecs honnêtes.
- [x] **Étape 3 — GitHub Pages + PWA** : manifest, service worker, icônes, meta iOS (construit + testé local ; déploiement à faire).
- [~] **Étape 4 — Notifications push matinales** : code + logique testés ; live à câbler (VAPID + table + install iOS).
- [ ] Étape 5 — Finitions UX (chrono, semaine à venir, synchro visible, onboarding)

## Lancer en local

Les modules ES et `fetch` ne marchent pas en `file://` → il faut un serveur HTTP.

```bash
cd carnet-de-pluie
python3 -m http.server 8080     # ou : npm run serve
```
Puis ouvrir <http://localhost:8080>.

## Tester le moteur

```bash
node test/engine.test.mjs        # ou : npm test
```

## Fichiers

| Fichier | Rôle |
|---|---|
| `index.html` | La page (mobile-first, thème sombre) |
| `styles.css` | Feuille de style |
| `app.js` | Présentation : fetch météo, cache, rendu, saisie |
| `engine.js` | **Moteur de décision** — source de vérité unique, partagée page + push |
| `store.js` | Accès à la base partagée Supabase (REST) |
| `config.js` | URL Supabase + clé **publique** (publishable) |
| `test/engine.test.mjs` | Tests du moteur (26 assertions) |
| `test/supabase.test.mjs` | Tests d'intégration Supabase (base réelle) |
| `TESTS.md` | Journal des tests (test → cassé → corrigé) |

## Supabase (base partagée)

Deux tables : `arrosages` (jour = clé primaire, minutes cumulées) et `reglages`
(objectif/débit). Policies RLS ouvertes — voir le SQL d'installation dans l'historique
du projet. **Note de sécurité honnête** : la clé `anon`/publishable est visible dans le
code publié (c'est voulu, elle est publique par conception) ; avec des policies ouvertes,
quiconque a l'URL de la page peut techniquement lire/écrire ces deux tables. Pour un
carnet d'arrosage, le risque est trivial. Ne **jamais** mettre la clé `secret` dans le code.

## Déploiement (GitHub Pages) & installation iOS

HTTPS est obligatoire pour un service worker et le Web Push — GitHub Pages sert
tout en HTTPS.

### 1. Publier sur GitHub Pages
```bash
cd carnet-de-pluie
git init && git add . && git commit -m "Carnet de pluie"
git branch -M main
git remote add origin https://github.com/<utilisateur>/<depot>.git
git push -u origin main
```
Puis sur GitHub : **Settings → Pages → Source : « Deploy from a branch »**, branche
`main`, dossier `/ (root)`. Après ~1 min, le site est sur
`https://<utilisateur>.github.io/<depot>/`.

> ⚠️ **Chemins en sous-dossier** : sur une « project page », le site vit sous
> `/<depot>/`. Tout est en **chemins relatifs** et le manifest utilise
> `"scope": "./"` / `"start_url": "./"` — le service worker ne couvre que son
> dossier et en-dessous, ça tombe juste. Un dépôt `<utilisateur>.github.io`
> (servi à la racine) simplifie encore.

### 2. Installer sur l'écran d'accueil (iPhone)
1. Ouvrir le site dans **Safari** (iOS ≤ 16.3 : Safari uniquement ; iOS 16.4+ :
   Chrome/Edge/Firefox marchent aussi).
2. Bouton **Partager** → **« Sur l'écran d'accueil »** → **Ajouter**.
3. Lancer l'app depuis son icône : elle s'ouvre en plein écran (standalone).

### 3. Limites honnêtes iOS (vérifiées — WebKit/Apple, 2023-2025)
- **Push web seulement en mode installé** (ajouté à l'écran d'accueil), **iOS 16.4+**.
  En onglet Safari iOS, le push web n'existe pas.
- **Geste utilisateur obligatoire** pour la permission de notif — pas de prompt
  automatique. → bouton « Activer les notifications » (étape 4).
- **Pas de notification locale planifiée fiable** : un rappel quand l'app est
  fermée passe forcément par un **push serveur** (d'où le cron GitHub Actions, étape 4).
  L'alarme de fin de chrono ne sonne que si l'app est **ouverte**.
- **Pas de push silencieux** : chaque push doit afficher une notification visible.
- **Stockage non garanti** : une PWA installée échappe à la purge « 7 jours » de
  Safari, mais le cache peut être évincé sous pression disque. Ici sans risque :
  la vérité est dans Supabase, le local n'est qu'un cache.
- **Icône** : `apple-touch-icon` 180×180 **opaque** (iOS applique son propre masque
  arrondi et ignore les icônes « maskable » du manifest ; l'apple-touch-icon prime).

### 4. Envoi push serveur (Node, étape 4)
Librairie **`web-push`** + clés **VAPID**. Payload ≤ 4 Ko. Gérer les codes **404/410**
= abonnement mort → supprimer la subscription de la base.

## Notifications push — installation

1. **Table Supabase** (SQL Editor) :
   ```sql
   create table push_subscriptions (
     endpoint text primary key,
     subscription jsonb not null,
     auteur text,
     created_at timestamptz default now()
   );
   alter table push_subscriptions enable row level security;
   create policy "open" on push_subscriptions for all using (true) with check (true);
   ```
2. **Clés VAPID** : `npx web-push generate-vapid-keys`
   - **Public Key** → coller dans `config.js` (`VAPID_PUBLIC`).
   - **Private Key** → GitHub **Settings → Secrets and variables → Actions → New secret**,
     nom `VAPID_PRIVATE_KEY`. **Ne jamais** committer la clé privée.
3. **Activer sur chaque iPhone** : ouvrir la PWA **installée** (pas Safari) →
   Réglages → « 🔔 Activer les notifications » (iOS exige ce geste).
4. **Test manuel** : GitHub → onglet **Actions** → workflow « Rappel matinal » →
   **Run workflow** avec `force = 1` (envoie sans attendre 6h).
5. **Rythme** : le cron tourne à 4h30 et 5h30 UTC ; le script n'envoie que si
   l'heure locale Zurich est 6h → rappel effectif ~6h30, seulement si l'état du
   jour est « Arroser » ou « La pluie s'en charge (alors qu'il aurait fallu arroser) ».

## Le moteur en bref

```
pluie_reçue  = Σ pluie des 7 derniers jours (aujourd'hui inclus)
pluie_prévue = Σ pluie des 3 prochains jours
arrosé_mm    = (minutes arrosées sur 7 j / 60) × débit
déficit      = max(0, objectif − pluie_reçue − pluie_prévue − arrosé_mm)
```

1. `déficit ≤ 0` → ✅ **Rien à faire**
2. `pluie ≥ 5 mm sous 48 h` → 🌧️ **La pluie s'en charge**
3. dernier arrosage sérieux (≥ 8 mm) il y a < 3 j → ⏳ **Attends** (le sol doit sécher)
4. `déficit < 10 mm` → 🌱 **Presque bon**
5. sinon → 💧 **Arroser N min** (session 10–20 mm ; au-delà, 2ᵉ session à J+3)

Réglages par défaut : objectif **28 mm/semaine**, débit **27 mm/h** (modifiables).
