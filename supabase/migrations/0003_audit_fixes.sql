-- =====================================================================
-- 0003_audit_fixes.sql — Correctifs de sécurité issus de l'audit (2026-07-14)
-- =====================================================================
-- Idempotent (create or replace / drop+create). Sûr à ré-exécuter.

-- --- FIX 1 : accept_invitation ne doit JAMAIS modifier le rôle d'un membre déjà
-- présent (sinon un membre qui reçoit un lien admin partagé s'auto-promeut admin).
-- Le rôle existant fait foi ; une invitation n'ajoute que les NOUVEAUX membres.
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

  -- do nothing : un membre existant garde son rôle (pas d'escalade via un lien).
  insert into public.domicile_members (domicile_id, user_id, role)
  values (inv.domicile_id, uid, inv.role)
  on conflict (domicile_id, user_id) do nothing;

  select * into new_row from public.domicile_members
  where domicile_id = inv.domicile_id and user_id = uid;
  return new_row;
end;
$$;

-- --- FIX 2 : push_subscriptions — un utilisateur ne peut enregistrer un abonnement
-- QUE pour un domicile dont il est membre (sinon il reçoit les notifs — donc le
-- signal présence/absence — d'un domicile étranger).
drop policy if exists sub_own on public.push_subscriptions;
create policy sub_own on public.push_subscriptions for all to authenticated
  using ( user_id = (select auth.uid()) )
  with check ( user_id = (select auth.uid()) and (domicile_id is null or private.is_member(domicile_id)) );

-- --- FIX 3 : protéger le propriétaire — un admin (non-owner) ne peut ni supprimer
-- ni modifier la ligne 'owner' (éviction / verrouillage du propriétaire).
drop policy if exists mem_delete on public.domicile_members;
create policy mem_delete on public.domicile_members for delete to authenticated
  using ( (private.is_admin(domicile_id) and role <> 'owner') or user_id = (select auth.uid()) );

drop policy if exists mem_update on public.domicile_members;
create policy mem_update on public.domicile_members for update to authenticated
  using ( private.is_admin(domicile_id) and (role <> 'owner' or user_id = (select auth.uid())) )
  with check ( private.is_admin(domicile_id) );

-- =====================================================================
-- FIN 0003.
-- =====================================================================
