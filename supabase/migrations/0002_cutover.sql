-- =====================================================================
-- 0002_cutover.sql — BASCULE : Anières = 1er domicile, historique rattaché,
-- puis FERMETURE de la RLS ouverte.
-- =====================================================================
-- ⚠️ CASSE VOLONTAIREMENT l'ancien accès anonyme. À exécuter SEULEMENT quand :
--   1. les comptes existent (Ernest = owner, le père = membre) ;
--   2. le nouveau client (branche feature/comptes-domiciles) est déployé ;
--   3. « Confirm email » est désactivé au dashboard (cercle privé) ;
--   4. la clé secrète (SB_SECRET) est dans les secrets GitHub Actions (push matinal).
--
-- AVANT DE LANCER : remplacer les deux emails ci-dessous par les vrais.
--   __ERNEST_EMAIL__  → l'email du compte propriétaire (Ernest)
--   __PERE_EMAIL__    → l'email du compte du père (créé AVANT le cutover, sinon
--                        son app perd l'accès jusqu'à ce qu'il rejoigne le domicile)
--
-- Rollback : ré-ouvrir les policies (voir 0099_rollback_open_rls.sql). Les données
-- ne sont pas détruites (aucun DROP de colonne/table de données).
-- =====================================================================

-- --- 1. SEED : domicile Anières + rattachement de l'historique + membres ---
do $$
declare
  v_ernest_email text := '__ERNEST_EMAIL__';
  v_pere_email   text := '__PERE_EMAIL__';
  v_ernest uuid;
  v_pere   uuid;
  v_dom    uuid;
  v_reg    record;
begin
  -- Comptes
  select id into v_ernest from auth.users where lower(email) = lower(v_ernest_email);
  if v_ernest is null then
    raise exception 'Compte propriétaire introuvable pour %. Crée-le AVANT le cutover.', v_ernest_email;
  end if;
  select id into v_pere from auth.users where lower(email) = lower(v_pere_email);
  if v_pere is null then
    raise notice 'Compte du père introuvable (%). La bascule continue, mais il devra rejoindre via le lien d''invitation — son app sera coupée d''ici là.', v_pere_email;
  end if;

  -- Réglages actuels (ligne globale id=1) à recopier sur le domicile.
  select objectif_mm, debit_mm_h, kc, objectif_manuel into v_reg from public.reglages where id = 1;

  -- Crée le domicile Anières s'il n'existe pas déjà (idempotent sur le nom+owner).
  select id into v_dom from public.domiciles where nom = 'Anières' and owner_id = v_ernest;
  if v_dom is null then
    insert into public.domiciles (nom, adresse, lat, lon, timezone, objectif_mm, debit_mm_h, kc, objectif_manuel, owner_id)
    values ('Anières', 'Anières, Genève, Suisse', 46.2777, 6.2234, 'Europe/Zurich',
            coalesce(v_reg.objectif_mm, 28), coalesce(v_reg.debit_mm_h, 27),
            coalesce(v_reg.kc, 0.8), coalesce(v_reg.objectif_manuel, false), v_ernest)
    returning id into v_dom;
    -- Le trigger trg_owner_membership a déjà inséré Ernest comme owner.
  end if;

  -- Nom affiché d'Ernest (owner déjà créé par le trigger) : « Ernest ».
  update public.domicile_members set prenom = coalesce(prenom, 'Ernest')
    where domicile_id = v_dom and user_id = v_ernest;

  -- Le père : membre du domicile (nom affiché « Papa »).
  if v_pere is not null then
    insert into public.domicile_members (domicile_id, user_id, role, prenom)
    values (v_dom, v_pere, 'member', 'Papa')
    on conflict (domicile_id, user_id) do update set prenom = coalesce(public.domicile_members.prenom, 'Papa');
  end if;

  -- Rattache TOUT l'historique existant (arrosages + contraintes) au domicile Anières.
  update public.arrosages   set domicile_id = v_dom where domicile_id is null;
  update public.contraintes set domicile_id = v_dom where domicile_id is null;
  -- push_subscriptions : 0 ligne aujourd'hui ; on laisse domicile_id/user_id null
  -- (les appareils se ré-abonneront après connexion). Rien à backfiller.

  raise notice 'Seed OK : domicile Anières = %, historique rattaché.', v_dom;
end $$;

-- --- 2. Contraintes d'intégrité (après backfill) -----------------------
-- arrosages : clé primaire passe de (jour) à (domicile_id, jour) → un jour par domicile.
alter table public.arrosages   drop constraint if exists arrosages_pkey;
alter table public.arrosages   add primary key (domicile_id, jour);   -- rend domicile_id NOT NULL
alter table public.contraintes alter column domicile_id set not null;

-- --- 3. FERMETURE DE LA RLS (remplace les policies « open » par appartenance) ---
alter table public.arrosages          enable row level security;
alter table public.contraintes        enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.reglages           enable row level security;

drop policy if exists "open" on public.arrosages;
drop policy if exists "open" on public.contraintes;
drop policy if exists "open" on public.push_subscriptions;
drop policy if exists "open" on public.reglages;   -- table abandonnée : on la verrouille

create policy arr_all on public.arrosages for all to authenticated
  using ( private.is_member(domicile_id) ) with check ( private.is_member(domicile_id) );

create policy contr_all on public.contraintes for all to authenticated
  using ( private.is_member(domicile_id) ) with check ( private.is_member(domicile_id) );

-- Un appareil (subscription) appartient à SON utilisateur. Le serveur push lit via
-- la clé secrète (bypass RLS), donc pas besoin de policy de lecture serveur ici.
create policy sub_own on public.push_subscriptions for all to authenticated
  using ( user_id = (select auth.uid()) ) with check ( user_id = (select auth.uid()) );

-- reglages : plus aucune policy → verrouillée (table abandonnée, conservée en archive).

-- =====================================================================
-- FIN 0002 — la base est cloisonnée par domicile. L'ancien accès anonyme
-- est coupé : seuls les membres connectés (nouveau client) accèdent aux données.
-- =====================================================================
