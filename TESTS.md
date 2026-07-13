# TESTS — Carnet de pluie

Journal de la boucle **test → ce qui a cassé → correction**, partie par partie.
Rien n'est marqué « fini » sans avoir été exécuté sur de vraies données.

---

## Étape 1 — Cœur local (page + météo + moteur)

### 1.1 API météo (fetch réel)
- **Testé** : `curl` de l'URL MétéoSuisse ICON CH2 (Anières 46.2777, 6.2234).
- **Résultat** : 200 OK. 12 jours renvoyés (`2026-07-02` → `2026-07-13`), soit 7 passés + aujourd'hui + 4 prévus. `time` contient bien la date du jour (`2026-07-09`, index 7). Fuseau `Europe/Zurich` confirmé. Météo du jour : 0 mm partout (canicule sèche) → cas de test réel « il faut arroser ».
- **Cassé / corrigé** : rien.

### 1.2 Moteur de décision (`engine.js`) — `node test/engine.test.mjs`
- **Testé** : les 5 scénarios du plan + 21 cas limites.
- **Résultat** : **26 PASS / 0 FAIL**.
  - S1 déficit 0 → `rien` ✓
  - S2 8 mm de pluie demain → `pluie` (pluie_48h=8) ✓
  - S3 arrosé hier 30 min → `attends`, prochain arrosage 07-11 (samedi) ✓
  - S4 déficit 6 mm → `presque` ✓
  - S5 déficit 28 mm → `arroser` **44 min**, session plafonnée à 20 mm, **2ᵉ session 18 min le 07-12 (dim.)** ✓
  - Cas limites : fuseau/fallback `todayIdx`, `time` vide → `erreur` (pas de fausse reco), arrosé aujourd'hui → `fait`, agrégation père+fils le même jour (40 min), arrosages invalides (≤0) ignorés, réglages custom (obj 15 / débit 30 → 30 min).
- **Cassé / corrigé** : rien (écrit en TDD, passé du 1er coup après vérification manuelle des nombres).

### 1.3 Rendu bout-en-bout (Chrome headless, données réelles)
- **Testé** : chargement de `index.html` servi en HTTP local, DOM final extrait.
- **Résultat** : verdict = « **Arroser 44 min** », sous-titre « Session de 20 mm, au débit de 27 mm/h », « ↳ puis ~18 min vers **dim. 12 juil.** », date « Jeudi 9 juillet », état `state-arroser`. Chaîne fetch réel → moteur → DOM OK.

### 1.4 Mise en page mobile (débordement horizontal)
- **Cassé (faux positif)** : 1re capture semblait tronquée à droite.
- **Diagnostic** : mesuré `body.scrollWidth` vs `innerWidth` en iframe même-origine → **aucun débordement à 320 / 375 / 390 px**. Le « débordement » venait de `--force-device-scale-factor=2` combiné à `--window-size` qui divisait le viewport CSS de moitié (artefact de capture, pas un bug de l'app).
- **Corrigé** : capture refaite au bon viewport (780 device @2x = 390 CSS). Rendu net et sans coupe.

### 1.5 QA visuelle des 6 états + graphe (Chrome headless)
- **Testé** : banc jetable rejouant le **vrai moteur** sur 6 scénarios, rendu avec le CSS de prod.
- **Résultat** : `arroser` (ambre), `pluie` (bleu), `attends` (sauge, « Attends samedi »), `fait`, `presque` (sable), `rien` (sauge) — tous lisibles, accent sémantique correct, halo teinté par l'état. Graphe de pluie : barres pleines (passé), hachurées (prévu) avec probabilités %, aujourd'hui surligné ambre.
- **Cassé** : double point « ~32 min le sam. 11 juil.**.** » (le format abrégé finit déjà par « . »).
- **Corrigé** : point final ajouté seulement si la date formatée ne finit pas déjà par un point (`app.js`, état `attends`). Re-testé → point simple.

### 1.6 Intégration des handlers réels (iframe même-origine)
- **Testé** : les vrais boutons/validations de `index.html`.
- **Résultat** :
  - minutes = 0 → refusé (« Entre un nombre de minutes valide. ») ✓
  - date future → refusé (« Pas de date future. ») ✓
  - enregistrement valide → ✓ + historique « Mer. 8 juil. — 30 min (Papa) » (auteur affiché) ✓
  - **cumul même jour** : 30 + 20 = **50 min** au total, localStorage cohérent ✓
  - **bascule du verdict** : arrosé 80 min aujourd'hui (36 mm) → « Rien à faire » ; arrosé 30 min hier → « Attends samedi » ✓
  - Bonus : sans météo ni cache → état `erreur` propre (« Météo indisponible »), **la saisie reste fonctionnelle hors-ligne** ✓
- **Cassé / corrigé** : rien de plus.

### Limites connues (assumées, cf. plan)
- **Étape 1** : l'historique et le prénom sont en **localStorage** (pas encore partagés). Le partage père/fils arrive à l'étape 2 (Supabase).
- Pas encore de synchro multi-appareils, PWA, push, chrono, bande semaine, onboarding (étapes 2 à 5).
- Débit 27 mm/h = 1 seul point de mesure (±20–30 %), modifiable dans Réglages.

### Reste à tester dans les étapes suivantes
- Envoi push réel + subscription 410 nettoyée — étape 4.
- Chrono lancer/stop → entrée Supabase — étape 5.

---

## Étape 2 — Historique partagé (Supabase)

### 2.1 Backend (connexion + CRUD, base réelle via `curl`/`fetch`)
- **Testé** : GET/POST(upsert)/PATCH/DELETE sur le projet Supabase réel avec la clé publishable.
- **Résultat** :
  - `GET reglages` → ligne par défaut `{objectif:28, débit:27}` (le SQL a bien pris) ✓
  - upsert insert → 201 ; upsert même jour → **remplace** (last-write-wins), d'où la règle *lire → additionner → upsert* côté client ✓
  - PATCH réglages ✓ ; DELETE purge ✓ ; policies RLS ouvertes autorisent lecture/écriture anonymes ✓
- **Cassé / corrigé** : rien. Nuance apprise : `merge-duplicates` **remplace** (n'additionne pas) → la somme se fait côté client.

### 2.2 Module `store.js` — `node test/supabase.test.mjs`
- **Résultat** : **9 PASS / 0 FAIL** (réglages défaut, upsert, relecture, remplacement même jour, PATCH aller-retour, purge ciblée). Non destructif (jour bidon 2020-01-01, nettoyé).

### 2.3 Cycle réel *lire → additionner → upsert* (Node, vraie base)
- **Résultat** : **3 PASS / 0 FAIL** — 1er save 25 min, 2e save +15 le même jour → **cumul à 40 min** (exactement la logique de `saveArrosage`), puis nettoyage.

### 2.4 Câblage DOM du bouton (headless, Supabase mocké)
- **Cassé (méthode de test)** : 2 tentatives d'un harness headless multi-rechargement sont restées **sans sortie** et la base ressortait vide.
- **Diagnostic** : `--virtual-time-budget` accélère les timers → Chrome se fermait **avant** que le POST réseau réel vers Supabase se termine (en étape 1 les saves étaient synchrones en localStorage, d'où le succès). Ce n'était **pas** un bug de l'app.
- **Corrigé (2 tests séparés fiables)** :
  1. cycle réel en **Node** (§2.3) pour l'écriture réseau,
  2. câblage DOM avec **Supabase mocké en succès instantané** (pas de dépendance au timing réseau).
- **Résultat câblage** : clic Enregistrer 40 min → « ✓ Enregistré » → verdict recalculé « Attends samedi » → historique « (Ernest) » ✓. **Échec honnête** : Supabase en échec → « Rien n'a été sauvegardé » + bouton **Réessayer**, historique inchangé (aucun faux ✓) ✓.

### 2.5 Intégrité visuelle après refacto
- **Testé** : capture de l'app avec la couche Supabase active.
- **Résultat** : rendu identique à l'étape 1, nouvelle ligne de statut « météo à l'instant · synchro à l'instant ». Rien de cassé.

### Limites connues (étape 2)
- **Last-write-wins** assumé pour 2 utilisateurs (acceptable, cf. plan).
- Le prénom (`auteur`) reste **local à l'appareil** (localStorage) — Ernest sur son tel, Papa sur le sien. L'onboarding qui le demande au 1er lancement = étape 5.
- Purge 14 j déclenchée au chargement (best-effort, n'empêche pas la lecture si elle échoue).

### Reste à tester (après étape 2)
- Envoi push réel + subscription 410 nettoyée — étape 4.
- Chrono lancer/stop → entrée Supabase — étape 5.

---

## Étape 3 — Mise en ligne (GitHub Pages) + PWA

### 3.1 Recherche des contraintes iOS (agent parallèle, sources primaires)
- **Fait** : agent dédié → faits vérifiés (WebKit, Apple Developer, MDN, 2023-2025) sur PWA/iOS + Web Push.
- **Corrections apportées à la construction** :
  - iOS **ignore** les icônes `maskable` et applique son propre masque → il faut une icône **carrée pleine, opaque**. La mienne l'est (fond couvrant tout le carré). ✓
  - `apple-touch-icon` **prime** sur les icônes du manifest → balise ajoutée (180×180 opaque). ✓
  - Confirmé : push iOS **16.4+**, **mode installé uniquement**, **geste utilisateur requis**, pas de notif locale planifiée, purge « 7 j » **inapplicable** en installé.

### 3.2 Manifest + fichiers PWA
- **Testé** : servis en local + validité.
- **Résultat** : `manifest.json` JSON valide (display standalone, 3 icônes), icônes 192/512/180 générées (goutte ambre sur fond nuit), toutes servies en 200 avec le bon type MIME. Meta iOS présentes (`manifest`, `apple-mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style`, `apple-touch-icon`, `mobile-web-app-capable`).

### 3.3 Service worker — intégrité du précache
- **Testé** : chaque entrée de `CORE` dans `sw.js` renvoie 200 (une seule entrée manquante ferait échouer `addAll` → installation KO).
- **Résultat** : **11/11 fichiers en 200** → précache ne peut pas échouer. Syntaxe `sw.js` valide.
- **Stratégies** : APIs (open-meteo, supabase) jamais cachées par le SW ; Google Fonts en cache-first ; navigation en network-first ; assets même-origine en stale-while-revalidate. Bump `VERSION` à chaque déploiement.

### 3.4 Limite de test connue (honnête)
- Le **cycle de vie runtime du SW** (install → activate → cache → offline → mode standalone iOS) **n'est PAS testable de façon fiable en Chrome headless one-shot** : `--virtual-time-budget` ferme le navigateur avant la fin de l'install async, et un profil disque neuf gèle. J'ai vérifié tout ce qui est vérifiable statiquement (précache intègre, manifest valide, code d'enregistrement standard, syntaxe). **Le test définitif (installation, offline, écran d'accueil) se fait sur le site https en ligne / l'iPhone** — à confirmer au déploiement.

### 3.5 Déploiement en production (VÉRIFIÉ)
- Repo public créé + poussé : `github.com/Nenesrider27/carnet-de-pluie`. Pages activé.
- **Site en ligne** : https://nenesrider27.github.io/carnet-de-pluie/ (HTTP 200 après ~25 s).
- Tous les fichiers servis en 200 avec le bon type MIME (JS en `application/javascript` → `import` OK).
- **Rendu production vérifié** (headless sur l'URL live) : « Arroser 44 min », date correcte,
  « météo à l'instant · synchro à l'instant » → météo **et** lecture Supabase OK depuis l'origine https.

### Reste sur appareil (étape 3)
- Ajout à l'écran d'accueil + test SW/offline en mode installé : **à confirmer sur l'iPhone d'Ernest** (non testable en headless).

---

## Étape 4 — Notifications push matinales

### 4.1 Logique décision→notification — `node test/notify.test.mjs`
- **Testé** : quels états déclenchent un push et le texte, via `planNotification` (fonction pure de `morning-push.mjs`), même moteur que la page.
- **Résultat** : **8 PASS / 0 FAIL**
  - ARROSER (sec) → push, titre « 💧 Arrose ~44 min ce matin », corps mentionne le déficit ✓
  - PLUIE avec besoin réel (rejoue sans la pluie 48 h → aurait été « arroser ») → push « 🌧️ La pluie s'en charge » ✓
  - PLUIE **sans** besoin (déjà bien arrosé) → **pas** de push ✓
  - RIEN / ATTENDS → **pas** de push (jamais de spam « rien à faire ») ✓

### 4.2 web-push installable
- **Testé** : `npm install web-push@3` (comme le workflow) + import.
- **Résultat** : installé, `generateVAPIDKeys` disponible. Le workflow `npm install web-push@3` fonctionnera.

### 4.3 Garde-fous du script
- Heure locale Zurich ≠ 6h et pas de `FORCE=1` → sort sans rien faire (le 2e créneau cron gère été/hiver).
- `VAPID_PRIVATE_KEY` absent ou `VAPID_PUBLIC` non renseigné → erreur explicite (pas d'envoi silencieux).
- Sur envoi : code 404/410 → subscription supprimée de la base.

### Limites de test connues (honnête)
- **La livraison réelle d'un push n'est pas testée** ici : elle exige (1) la table `push_subscriptions`, (2) de vraies clés VAPID, (3) la PWA **installée** sur un iPhone qui s'abonne, (4) le site en https. C'est un test **sur appareil**, à faire une fois déployé.
- Rappel iOS (vérifié étape 3.1) : push **seulement en mode installé**, **iOS 16.4+**, geste utilisateur requis.

### À faire avec Ernest (étape 4)
- Créer la table `push_subscriptions` (SQL dans le README). ✅ fait
- `npx web-push generate-vapid-keys` → clé publique dans `config.js`, clé privée en secret GitHub `VAPID_PRIVATE_KEY`. ✅ fait
- Installer la PWA sur chaque iPhone → activer les notifs → tester via **Actions → Run workflow (force=1)**.

---

## Étape 5 — Finitions UX

### 5.1 Projection « semaine à venir » (moteur)
- **Amélioré** : `projectWeek` SIMULE qu'on suit la reco (arrosage virtuel les jours « arroser ») → montre les VRAIES prochaines sessions, pas « arroser » répété.
- **Testé** : temps sec → aujourd'hui « arroser 44min », puis attends (repos), puis presque. ✅
- Bande 7 pastilles rendue et vérifiée visuellement (AUJ surligné, 💧+minutes, ⏳ repos, 🌱, · inconnu) ; cohérente avec le verdict (« prochaine session samedi » = SAM 💧 dans la bande).

### 5.2 Chrono d'arrosage
- **Testé visuellement** : overlay plein écran, compte à rebours Fraunces ambre (44:00→…), barre de progression, objectif, tip iOS honnête (son de fin seulement si page ouverte), boutons Stop/Annuler.
- **Cassé** : bouton « Stop » trop haut (héritait `flex:1 1 130px` de la rangée horizontale dans une colonne). **Corrigé** : `flex:0 0 auto`.
- **Câblage vérifié** : état « arroser » → boutons ▶ Lancer / ✓ C'est fait s'affichent (mock : `v-actions visible=true`).
- **Audio** : `AudioContext` débloqué sur le geste « Lancer » (contrainte iOS), 3 bips à la fin, seulement si page visible.

### 5.3 Enregistrement rapide (« C'est fait » / fin de chrono)
- **Testé fonctionnel** (mock upsert) : Arroser 44 → clic « C'est fait » → toast « ✓ 44 min enregistrées » → verdict bascule « C'est fait » → POST en base `{2026-07-10, 44, Ernest}`. ✅
- Refactor : cœur `recordArrosage(date,min)` partagé entre formulaire manuel, « C'est fait » et chrono (une seule logique d'écriture).
- Le formulaire manuel (date passée + minutes) est passé en section repliée.

### 5.4 Onboarding 3 écrans
- **Testé** (parcours complet headless) : overlay au 1er lancement → prénom → « comment lire la reco » → « ajout écran d'accueil » → fermeture ; `cp.prenom` et `cp.onboarded` sauvés, prénom reflété dans Réglages. ✅
- Saute l'écran « écran d'accueil » si déjà en mode installé (`isStandalone`).
- **Faux positif de test** : 1re capture semblait tronquée → artefact `--force-device-scale-factor=2` (viewport CSS divisé). Mesuré à 390px réel : **aucun débordement**.

### 5.5 Synchro visible (déjà en place étapes 2)
- Ligne « [Prénom] a arrosé N min hier/aujourd'hui » (`sync-note`), indicateur « météo/synchro il y a X », re-fetch sur `visibilitychange`.

### Non-régression
- Après étape 5 : moteur **26/26**, notif **8/8**, supabase **9/9**. Rendu global inchangé (verdict, bande, cartes).

### Reste sur appareil (final)
- Installer la PWA + activer notifs sur les 2 iPhones → test livraison push réelle (Actions force=1).
- Test chrono réel sur téléphone (lancer 1 min → stop → entrée en base).

---

## Évolution — Objectif dynamique (ET₀) + Absences/Chat

### E.1 API ET₀ (vérifié en premier, tout en dépend)
- `et0_fao_evapotranspiration` **présent et non-null sur MétéoSuisse ICON CH2** (12/12) → pas de fallback nécessaire.
- Fallback modèle global (sans `models=`) : et0 non-null aussi (12/12) → filet de sécurité confirmé, codé défensivement.
- Données réelles du jour (canicule) : ET₀ 6–8 mm/j → objectif ~33 mm vs 28 fixe (l'ancien fixe sous-arrosait ~18 %).

### E.2 Objectif dynamique (moteur) — `node test/objectif.test.mjs`
- **15 PASS / 0 FAIL** : ET₀ 7 → objectif 39 (canicule) ; ET₀ 2.5 → borné 15 ; ET₀ absente/incomplète → repli 28 ; mode manuel → calcul ignoré ; Kc custom ; canicule resserre espacement (3→2) et MIN (10→8).
- Non-régression : sans ET₀ → repli 28 → 26/26 moteur inchangés (test « réglages custom » mis à jour : objectif fixe = mode manuel).

### E.3 Intégration app (ET₀)
- Fetch et0 + fallback global + **cache 3 h** (quota). Bandeau climat (🔥 canicule 39 mm / 🌥️ frais 15 mm / repli). Réglages : objectif calculé, Kc éditable, mode manuel. Règle 0. ET₀ dans la bande semaine.
- Testé headless (seed cache) : ET₀ 7 → bandeau canicule + objectif 39 ; ET₀ 2.5 → frais + 15. Visuel confirmé.
- `morning-push.mjs` : fetch et0 → **même objectif que la page** (module engine partagé).

### E.4 Absences (base du chat)
- Moteur : états `avant-depart` / `absent` — **8 PASS / 0 FAIL** (veille du départ sec → arrose avant de partir ; pendant absence → absent ; pluie/déjà servi → pas de nudge inutile).
- `store.js` contraintes : **4 PASS** sur la vraie base (add/get/delete/purge).
- App : dashboard s'adapte (headless : « Arrose avant de partir » / « Tu es absent » + bande 🚪).

### E.5 Chat (Edge Function Claude)
- Panneau UI construit (bulles, contexte, « Appliquer »), dégradation gracieuse si non déployé. Visuel confirmé.
- **Appel réel vérifié (HTTP 200)** après déploiement par Ernest : Claude comprend « vendredi 17h → dimanche soir » → dates 17-19, reprend la durée du dashboard (pas d'invention), propose l'absence structurée.
- CORS validé pour l'origine du site. Colonnes réglages (kc/objectif_manuel) créées et lues.
- **Garde-fou honnête** : endpoint public → plafond de dépense sur la clé Anthropic = vraie protection.

### Total : 66 tests unitaires/intégration au vert (26 + 8 + 15 + 8 + 9) + vérifs headless + appel Claude réel.
