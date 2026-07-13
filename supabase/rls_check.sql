-- rls_check.sql — Vérifie le modèle de sécurité (RLS + trigger + RPC) SANS
-- persister quoi que ce soit : tout se déroule dans un bloc DO qui se termine
-- TOUJOURS par une exception sentinelle → la transaction implicite est annulée
-- (rollback), y compris les 2 faux comptes auth.users insérés pour le test.
--
-- Simule deux utilisateurs A et B via request.jwt.claims + rôle `authenticated`
-- (la RLS s'applique au rôle authenticated, pas au superuser). Résultat attendu :
-- l'exécution se termine par l'erreur « RLS_CHECK_OK » = tous les tests passés.
-- Toute autre erreur = un test a échoué (le message dit lequel).
do $$
declare
  a uuid := '11111111-1111-1111-1111-111111111111';
  b uuid := '22222222-2222-2222-2222-222222222222';
  d uuid;
  tok uuid;
  n int;
  blocked boolean;
begin
  -- 1) Faux comptes (en tant que postgres, avant de basculer de rôle)
  insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at)
  values ('00000000-0000-0000-0000-000000000000', a, 'authenticated','authenticated','a@rlscheck.local', now(), now()),
         ('00000000-0000-0000-0000-000000000000', b, 'authenticated','authenticated','b@rlscheck.local', now(), now());

  -- Applique la policy FERMÉE de contraintes (état post-0002) DANS la transaction
  -- annulée : avant le cutover, `contraintes` a encore la policy « open ». Le
  -- rollback (exception sentinelle finale) restaure l'état live intact.
  alter table public.contraintes enable row level security;
  drop policy if exists "open" on public.contraintes;
  drop policy if exists contr_all on public.contraintes;
  create policy contr_all on public.contraintes for all to authenticated
    using ( private.is_member(domicile_id) ) with check ( private.is_member(domicile_id) );

  -- 2) Bascule en utilisateur A (rôle authenticated + claim sub=A)
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role','authenticated')::text, true);
  perform set_config('role', 'authenticated', true);

  -- 3) A crée un domicile (le trigger l'ajoute comme owner-membre) + une contrainte
  insert into public.domiciles (nom, lat, lon, owner_id) values ('TestA', 46.2, 6.2, a) returning id into d;
  insert into public.contraintes (domicile_id, type, debut, fin) values (d, 'absence', '2020-01-01', '2020-01-05');

  -- 4) A voit bien son domicile + sa contrainte
  select count(*) into n from public.domiciles where id = d;
  if n <> 1 then raise exception 'FAIL: A ne voit pas son propre domicile (%).', n; end if;
  select count(*) into n from public.contraintes where domicile_id = d;
  if n <> 1 then raise exception 'FAIL: A ne voit pas sa contrainte (%).', n; end if;
  select count(*) into n from public.domicile_members where domicile_id = d and user_id = a and role = 'owner';
  if n <> 1 then raise exception 'FAIL: le trigger owner-membre n''a pas fonctionné (%).', n; end if;

  -- 5) Bascule en B (non membre) : il ne doit RIEN voir de A
  perform set_config('request.jwt.claims', json_build_object('sub', b, 'role','authenticated')::text, true);
  select count(*) into n from public.domiciles where id = d;
  if n <> 0 then raise exception 'FAIL: B voit le domicile de A (%) — ISOLATION CASSÉE.', n; end if;
  select count(*) into n from public.contraintes where domicile_id = d;
  if n <> 0 then raise exception 'FAIL: B voit la contrainte de A (%) — ISOLATION CASSÉE.', n; end if;

  -- 6) B ne peut pas écrire dans le domicile de A (RLS insert)
  blocked := false;
  begin
    insert into public.contraintes (domicile_id, type, debut, fin) values (d, 'absence', '2020-02-01', '2020-02-02');
  exception when others then blocked := true;
  end;
  if not blocked then raise exception 'FAIL: B a pu écrire dans le domicile de A — RLS insert cassée.'; end if;

  -- 7) A crée une invitation
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role','authenticated')::text, true);
  insert into public.invitations (domicile_id, role) values (d, 'member') returning token into tok;

  -- 8) B accepte l'invitation via la RPC (SECURITY DEFINER)
  perform set_config('request.jwt.claims', json_build_object('sub', b, 'role','authenticated')::text, true);
  perform public.accept_invitation(tok);

  -- 9) B est maintenant membre : il voit le domicile + la contrainte de A
  select count(*) into n from public.domiciles where id = d;
  if n <> 1 then raise exception 'FAIL: après invitation, B ne voit pas le domicile (%).', n; end if;
  select count(*) into n from public.contraintes where domicile_id = d;
  if n <> 1 then raise exception 'FAIL: après invitation, B ne voit pas la contrainte (%).', n; end if;

  -- 10) B (membre simple, pas admin) ne peut PAS supprimer le domicile
  perform set_config('role', 'authenticated', true);
  blocked := false;
  begin
    delete from public.domiciles where id = d;
    get diagnostics n = row_count;
    if n = 0 then blocked := true; end if;   -- RLS a filtré la ligne (0 supprimée)
  exception when others then blocked := true;
  end;
  if not blocked then raise exception 'FAIL: B (membre) a pu supprimer le domicile — RLS delete admin cassée.'; end if;

  -- Tout est bon → exception sentinelle pour ANNULER toute la transaction.
  raise exception 'RLS_CHECK_OK';
end $$;
