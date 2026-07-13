-- Cutover tel qu'appliqué : Ernest a recréé Anières + Loix lui-même.
-- On rattache l'historique orphelin à SON Anières, on corrige la clé arrosages,
-- et on ferme la RLS.
-- Anières d'Ernest = 100fafcc-ffe9-4e03-988f-d9212c15e57f ; Ernest = 26033682-1ba6-4981-810a-540eb2206f34
update public.arrosages   set domicile_id = '100fafcc-ffe9-4e03-988f-d9212c15e57f' where domicile_id is null;
update public.contraintes set domicile_id = '100fafcc-ffe9-4e03-988f-d9212c15e57f' where domicile_id is null;
update public.domicile_members set prenom = 'Ernest'
  where domicile_id = '100fafcc-ffe9-4e03-988f-d9212c15e57f'
    and user_id = '26033682-1ba6-4981-810a-540eb2206f34' and prenom is null;

alter table public.arrosages   drop constraint if exists arrosages_pkey;
alter table public.arrosages   add primary key (domicile_id, jour);
alter table public.contraintes alter column domicile_id set not null;

alter table public.arrosages          enable row level security;
alter table public.contraintes        enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.reglages           enable row level security;
drop policy if exists "open" on public.arrosages;
drop policy if exists "open" on public.contraintes;
drop policy if exists "open" on public.push_subscriptions;
drop policy if exists "open" on public.reglages;
create policy arr_all   on public.arrosages   for all to authenticated using ( private.is_member(domicile_id) ) with check ( private.is_member(domicile_id) );
create policy contr_all on public.contraintes for all to authenticated using ( private.is_member(domicile_id) ) with check ( private.is_member(domicile_id) );
create policy sub_own   on public.push_subscriptions for all to authenticated using ( user_id = (select auth.uid()) ) with check ( user_id = (select auth.uid()) );
