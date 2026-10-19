-- Product price history: store_products.price / blink_price were overwritten in
-- place, so "Coca was 100 DA from 1 to 15 October, then 80 DA" was unanswerable.
-- Every price change is now a row in store_product_price_changes, written by a
-- BEFORE trigger in the same transaction as the write (same pattern as
-- pricing_changes), attributed to price_updated_by / price_update_source which
-- every writer sets alongside the price. Writes without attribution log as
-- source 'system'. The columns are write-only intent: the trigger clears them
-- after logging, so a row never carries a previous writer's attribution.
-- Reads: the store owner (RLS) and the server / console (service role).

alter table public.store_products
  add column if not exists price_updated_by uuid references public.users(id) on delete set null;
alter table public.store_products
  add column if not exists price_update_source text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'store_products_price_update_source_check') then
    alter table public.store_products
      add constraint store_products_price_update_source_check
      check (price_update_source in ('created', 'merchant', 'staff', 'library', 'system'));
  end if;
end $$;

create table if not exists public.store_product_price_changes (
  id uuid primary key default gen_random_uuid(),
  -- Deferred: the BEFORE INSERT trigger logs before the product row exists.
  product_id uuid not null references public.store_products(id) on delete cascade deferrable initially deferred,
  store_id uuid not null references public.stores(id) on delete cascade,
  old_price numeric(10, 2),
  new_price numeric(10, 2) not null,
  old_blink_price numeric(10, 2),
  new_blink_price numeric(10, 2) not null,
  source text not null check (source in ('created', 'merchant', 'staff', 'library', 'system', 'baseline')),
  changed_by uuid references public.users(id) on delete set null,
  changed_at timestamptz not null default now()
);

create index if not exists idx_price_changes_product on public.store_product_price_changes (product_id, changed_at desc);
create index if not exists idx_price_changes_store on public.store_product_price_changes (store_id, changed_at desc);

-- A store owner reads their own history; nobody writes from a client (the
-- trigger below is security definer).
alter table public.store_product_price_changes enable row level security;

drop policy if exists "price_changes_select_owner" on public.store_product_price_changes;
create policy "price_changes_select_owner" on public.store_product_price_changes
  for select using (
    exists (select 1 from public.stores s where s.id = store_id and s.owner_id = auth.uid())
  );

-- Atomic audit log: insert always logs; update logs only when a price moved.
-- BEFORE so it can clear the attribution columns on the row being written.
create or replace function public.log_store_product_price_change() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT'
     or new.price is distinct from old.price
     or new.blink_price is distinct from old.blink_price then
    insert into public.store_product_price_changes
      (product_id, store_id, old_price, new_price, old_blink_price, new_blink_price, source, changed_by)
    values (
      new.id,
      new.store_id,
      case when tg_op = 'UPDATE' then old.price else null end,
      new.price,
      case when tg_op = 'UPDATE' then old.blink_price else null end,
      new.blink_price,
      coalesce(new.price_update_source, 'system'),
      new.price_updated_by
    );
  end if;
  new.price_updated_by := null;
  new.price_update_source := null;
  return new;
end $$;

drop trigger if exists store_products_price_audit on public.store_products;
create trigger store_products_price_audit before insert or update on public.store_products
  for each row execute function public.log_store_product_price_change();

-- Backfill: today's price is the baseline of every existing product (once).
insert into public.store_product_price_changes
  (product_id, store_id, old_price, new_price, old_blink_price, new_blink_price, source, changed_at)
select p.id, p.store_id, null, p.price, null, p.blink_price, 'baseline', now()
  from public.store_products p
 where not exists (select 1 from public.store_product_price_changes c where c.product_id = p.id);
