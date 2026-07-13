-- =====================================================================
-- 0001_schema.sql — Comptes & domiciles : structure (100 % ADDITIF)
-- =====================================================================
-- SÛR À EXÉCUTER SUR LA BASE LIVE À TOUT MOMENT : ne crée que des tables,
-- fonctions et colonnes NOUVELLES (ou nullables). Ne touche PAS à la RLS des
-- tables existantes (arrosages/contraintes/push_subscriptions) → l'ancienne app
-- continue de fonctionner exactement comme avant. La bascule (fermeture RLS,
-- rapatriement de l'historique) est dans 0002_cutover.sql.
--
-- Idempotent autant que possible (IF NOT EXISTS / create or replace) : ré-exécutable.
-- =====================================================================

-- --- Schéma privé pour les fonctions anti-récursion RLS ----------------
-- Les fonctions SECURITY DEFINER vivent hors du schéma exposé par l'API.
create schema if not exists private;

-- =====================================================================
-- 1. TABLES
-- =====================================================================

-- Un domicile = un lieu (adresse + coordonnées) + ses réglages d'arrosage.
-- Les réglages (objectif/débit/kc) sont FUSIONNÉS ici : plus de table `reglages`
-- globale à ligne unique — chaque domicile a les siens.
create table if not exists public.domiciles (
  id              uuid primary key default gen_random_uuid(),
  nom             text not null,
  adresse         text,
  lat             double precision,
  lon             double precision,
  timezone        text not null default 'Europe/Zurich',
  objectif_mm     numeric not null default 28,
  debit_mm_h      numeric not null default 27,
  kc              numeric not null default 0.8,
  objectif_manuel boolean not null default false,
  owner_id        uuid not null references auth.users(id) on delete cascade,
  created_at      timestamptz not null default now()
);

-- Qui a accès à quel domicile, avec quel rôle et quel nom affiché.
-- La clé primaire composite garantit un seul membership par (domicile, user).
create table if not exists public.domicile_members (
  domicile_id  uuid not null references public.domiciles(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  role         text not null default 'member' check (role in ('owner','admin','member')),
  prenom       text,                       -- nom affiché de CE membre (ex. « Papa »)
  created_at   timestamptz not null default now(),
  primary key (domicile_id, user_id)
);

-- Invitations par lien web : le propriétaire crée un token, partage l'URL
-- `.../rejoindre?token=<uuid>`. L'invité NE LIT JAMAIS cette table : il passe
-- par la RPC accept_invitation (SECURITY DEFINER).
create table if not exists public.invitations (
  token        uuid primary key default gen_random_uuid(),
  domicile_id  uuid not null references public.domiciles(id) on delete cascade,
  role         text not null default 'member' check (role in ('member','admin')),
  created_by   uuid references auth.users(id) default auth.uid(),
  expires_at   timestamptz not null default (now() + interval '7 days'),
  revoked      boolean not null default false,
  created_at   timestamptz not null default now()
);

-- --- Colonnes domicile_id ajoutées aux tables existantes (nullables) ----
-- Nullable pour l'instant : le backfill + NOT NULL sont dans 0002_cutover.sql.
alter table public.arrosages          add column if not exists domicile_id uuid references public.domiciles(id) on delete cascade;
alter table public.contraintes        add column if not exists domicile_id uuid references public.domiciles(id) on delete cascade;
alter table public.push_subscriptions add column if not exists domicile_id uuid references public.domiciles(id) on delete cascade;
alter table public.push_subscriptions add column if not exists user_id     uuid references auth.users(id) on delete cascade;

create index if not exists idx_arrosages_domicile   on public.arrosages(domicile_id);
create index if not exists idx_contraintes_domicile on public.contraintes(domicile_id);

-- =====================================================================
-- 2. FONCTIONS ANTI-RÉCURSION (pattern officiel Supabase)
-- =====================================================================
-- SECURITY DEFINER + search_path='' figé : la fonction ne redéclenche pas la RLS
-- de domicile_members → casse le cycle domiciles ↔ domicile_members. Ranger dans
-- le schéma `private` (non exposé). NE PAS mettre `force row level security` sur
-- domicile_members, sinon ces fonctions y redeviendraient soumises.

create or replace function private.is_member(_domicile_id uuid)
returns boolean language sql security definer set search_path = '' stable as $$
  select exists (
    select 1 from public.domicile_members m
    where m.domicile_id = _domicile_id and m.user_id = (select auth.uid())
  );
$$;

create or replace function private.is_admin(_domicile_id uuid)
returns boolean language sql security definer set search_path = '' stable as $$
  select exists (
    select 1 from public.domicile_members m
    where m.domicile_id = _domicile_id and m.user_id = (select auth.uid())
      and m.role in ('owner','admin')
  );
$$;

revoke all on function private.is_member(uuid), private.is_admin(uuid) from public, anon;
grant execute on function private.is_member(uuid), private.is_admin(uuid) to authenticated;

-- --- Trigger : le créateur d'un domicile en devient owner-membre --------
-- Évite le chicken-and-egg (pour insérer le 1er membre il faudrait déjà être
-- admin). Le trigger SECURITY DEFINER insère la ligne owner automatiquement.
create or replace function private.add_owner_membership()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.domicile_members (domicile_id, user_id, role)
  values (new.id, new.owner_id, 'owner')
  on conflict (domicile_id, user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists trg_owner_membership on public.domiciles;
create trigger trg_owner_membership
  after insert on public.domiciles
  for each row execute function private.add_owner_membership();

-- =====================================================================
-- 3. RPC : rejoindre un domicile via un token d'invitation
-- =====================================================================
-- SECURITY DEFINER : peut insérer dans domicile_members sans donner à l'invité
-- de droit d'écriture direct. Contrôle existence/révocation/expiration, verrou
-- anti-concurrence. Lien MULTI-USAGE jusqu'à expiration/révocation (partage
-- familial : un seul lien pour le père ET le cousin) — on NE révoque PAS à
-- l'acceptation ; le propriétaire révoque à la main s'il le souhaite.
create or replace function public.accept_invitation(_token uuid)
returns public.domicile_members
language plpgsql security definer set search_path = '' as $$
declare
  inv     public.invitations;
  uid     uuid := (select auth.uid());
  new_row public.domicile_members;
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  select * into inv from public.invitations where token = _token for update;

  if not found            then raise exception 'invitation introuvable'; end if;
  if inv.revoked          then raise exception 'invitation révoquée';    end if;
  if inv.expires_at < now() then raise exception 'invitation expirée';   end if;

  insert into public.domicile_members (domicile_id, user_id, role)
  values (inv.domicile_id, uid, inv.role)
  on conflict (domicile_id, user_id) do update set role = excluded.role
  returning * into new_row;

  return new_row;
end;
$$;

revoke all on function public.accept_invitation(uuid) from public, anon;
grant execute on function public.accept_invitation(uuid) to authenticated;

-- =====================================================================
-- 4. RLS DES NOUVELLES TABLES (sûr : aucune ancienne app ne les touche)
-- =====================================================================

-- --- domiciles ---------------------------------------------------------
alter table public.domiciles enable row level security;

-- Le propriétaire voit TOUJOURS son domicile (owner_id), même indépendamment de
-- l'appartenance : nécessaire pour que `INSERT ... RETURNING` (create domicile)
-- fonctionne — le RETURNING est soumis à la policy SELECT, or l'appartenance n'est
-- créée que par le trigger AFTER INSERT (donc pas encore visible au RETURNING).
drop policy if exists dom_select on public.domiciles;
create policy dom_select on public.domiciles for select to authenticated
  using ( private.is_member(id) or owner_id = (select auth.uid()) );

drop policy if exists dom_insert on public.domiciles;
create policy dom_insert on public.domiciles for insert to authenticated
  with check ( owner_id = (select auth.uid()) );

drop policy if exists dom_update on public.domiciles;
create policy dom_update on public.domiciles for update to authenticated
  using ( private.is_admin(id) ) with check ( private.is_admin(id) );

drop policy if exists dom_delete on public.domiciles;
create policy dom_delete on public.domiciles for delete to authenticated
  using ( private.is_admin(id) );

-- --- domicile_members --------------------------------------------------
alter table public.domicile_members enable row level security;

drop policy if exists mem_select on public.domicile_members;
create policy mem_select on public.domicile_members for select to authenticated
  using ( user_id = (select auth.uid()) or private.is_member(domicile_id) );

-- Gestion des membres (ajout/retrait/rôle) réservée aux admins.
-- (Le 1er owner est créé par le trigger ; les autres rejoignent via la RPC.)
drop policy if exists mem_insert on public.domicile_members;
create policy mem_insert on public.domicile_members for insert to authenticated
  with check ( private.is_admin(domicile_id) );

drop policy if exists mem_update on public.domicile_members;
create policy mem_update on public.domicile_members for update to authenticated
  using ( private.is_admin(domicile_id) ) with check ( private.is_admin(domicile_id) );

-- Un admin retire qui il veut ; un membre peut se retirer lui-même (quitter).
drop policy if exists mem_delete on public.domicile_members;
create policy mem_delete on public.domicile_members for delete to authenticated
  using ( private.is_admin(domicile_id) or user_id = (select auth.uid()) );

-- --- invitations (admins uniquement ; l'invité passe par la RPC) -------
alter table public.invitations enable row level security;

drop policy if exists inv_admin_all on public.invitations;
create policy inv_admin_all on public.invitations for all to authenticated
  using ( private.is_admin(domicile_id) ) with check ( private.is_admin(domicile_id) );

-- =====================================================================
-- FIN 0001 — la base est prête à accueillir comptes et domiciles.
-- L'ancienne app fonctionne toujours (RLS des tables data inchangée).
-- Étape suivante = 0002_cutover.sql (comptes créés + client déployé).
-- =====================================================================
