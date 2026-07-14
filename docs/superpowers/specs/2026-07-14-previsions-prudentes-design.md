# Prévisions plus prudentes — Design

**Date** : 2026-07-14
**Statut** : validé en brainstorming (Ernest)
**Problème** : le moteur compte la pluie PRÉVUE à 100 % de sa valeur et ignore la
probabilité. Si une pluie annoncée ne tombe pas, le jardin peut rester sans eau
plusieurs jours (le temps que le moteur rattrape via la pluie mesurée). Risque de
sécheresse sur une prévision ratée, surtout en chaleur.

## Décisions (brainstorming)

- Arbitrage : **équilibre selon la fiabilité** de la prévision (pas de curseur fixe).
- Ampleur : **pondération par probabilité + filet de sécurité**.
- Seuil du filet : **3 jours** (2 en canicule).

## 1. Pondération par probabilité

- Pluie **mesurée** (passé + aujourd'hui, index ≤ idx) → **100 %** (c'est du réel).
- Pluie **prévue** (jours futurs, index > idx) → comptée **× (probabilité / 100)**,
  bornée [0, 1]. Probabilité manquante → 100 % (repli sûr, comportement actuel).
- Pondération **linéaire**, sans plancher.
- S'applique à `pluie_prevue` (déficit) ET `pluie_48h` (règle « la pluie s'en charge »),
  qui ne se déclenche donc plus sur une pluie douteuse.
- On conserve les valeurs **brutes** (`pluie_prevue_brute`, `pluie_48h_brute`) pour la
  transparence.

## 2. Filet de sécurité (max jours sans eau)

- `dryDays` = jours depuis le dernier apport d'eau **sérieux RÉEL** (≤ aujourd'hui) :
  pluie **tombée** ≥ `RAIN_SOON_MM` (5 mm) OU arrosage sérieux (`lastSignif`, ≥ 8 mm équiv.).
  La pluie **prévue** ne compte pas (elle n'est pas tombée).
- Nouvelle constante `MAX_DRY_DAYS = 3` (2 en canicule via `effConstants`).
- **Déclenchement** : `dryDays >= MAX_DRY_DAYS` ET `deficit >= MIN_SESSION_MM`.
- **Effet** : neutralise la règle « la pluie s'en charge » → on recommande d'arroser
  même si une pluie (même probable) est annoncée. Le déficit doit rester réel (≥ session utile).
- La décision porte un drapeau `filet` pour l'explication.

## 3. Transparence (« toujours le pourquoi »)

- Filet déclenché : *« X jours sans eau — on n'attend plus la pluie annoncée. »*
- Pluie fortement escomptée (brute ≥ 5 mm mais pondérée nettement plus faible) alors
  qu'on arrose : *« Pluie annoncée mais peu probable — pas prise en compte. »*

## 4. Portée & non-régression

- Change UNIQUEMENT `engine.js` (`CONSTANTS`, `effConstants`, `computeMetrics`, `baseDecide`)
  + le rendu du « pourquoi » dans `app.js`. `projectWeek`, contraintes, push : inchangés
  (ils passent par `decide`, donc héritent automatiquement de la logique).
- Moteur pur → 100 % testable.

## 5. Tests (nouveaux)

1. Pluie prévue **douteuse** (10 mm @ 30 %) → comptée ~3 mm → **arrose** (vs « rien » à 100 %).
2. Pluie prévue **sûre** (10 mm @ 95 %) → comptée ~9.5 mm → **la pluie s'en charge / rien**.
3. **Filet** : ≥ 3 j sans eau + déficit réel + pluie annoncée → **arrose** (filet neutralise la pluie).
4. Filet **inactif** si arrosé/pluie récente (dryDays < 3).
5. Probabilité manquante → repli à 100 % (pas de régression).
