-- (Applied via the Supabase MCP, which recorded version 20261007130816.)
-- Multi-store checkout lookups (loadBundle, offer batching, claim / advance /
-- cancel updates) filter orders by checkout_id alone.
create index if not exists idx_orders_checkout on public.orders (checkout_id) where checkout_id is not null;
