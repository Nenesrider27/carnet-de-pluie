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

### Reste à tester (étapes suivantes)
- Envoi push réel + subscription 410 nettoyée — étape 4.
- Chrono lancer/stop → entrée Supabase — étape 5.
