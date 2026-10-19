-- Personal access tokens + audit trail for the staff MCP server (POST /mcp).
--
-- Blink ops/admin staff connect AI clients (Claude Desktop, Claude Code, ...) to
-- a read-only Model Context Protocol endpoint on blink-server. Each staff member
-- mints their own token in the dashboard; the server only ever stores the
-- sha256 hex digest (token_hash) and a short display prefix. A token is only as
-- powerful as its owner's CURRENT users.staff_role — clearing the role revokes
-- access instantly. Every tool call is recorded in staff_mcp_audit.
--
-- Token format: 'blk_mcp_' + 32 random bytes base64url. token_hash = sha256(token) hex,
-- token_prefix = first 12 chars of the token. Both tables are service-role only:
-- RLS on, no client policies.

create table if not exists public.staff_mcp_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  name text not null,
  token_hash text not null unique,
  token_prefix text not null,
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_staff_mcp_tokens_user
  on public.staff_mcp_tokens (user_id);

drop trigger if exists trg_staff_mcp_tokens_updated_at on public.staff_mcp_tokens;
create trigger trg_staff_mcp_tokens_updated_at
  before update on public.staff_mcp_tokens
  for each row execute function update_updated_at();

alter table public.staff_mcp_tokens enable row level security;

create table if not exists public.staff_mcp_audit (
  id bigint generated always as identity primary key,
  token_id uuid references public.staff_mcp_tokens(id) on delete set null,
  user_id uuid,
  tool text not null,
  args jsonb,
  ok boolean not null,
  error text,
  row_count int,
  duration_ms int,
  created_at timestamptz not null default now()
);

create index if not exists idx_staff_mcp_audit_created
  on public.staff_mcp_audit (created_at desc);
create index if not exists idx_staff_mcp_audit_user
  on public.staff_mcp_audit (user_id);

alter table public.staff_mcp_audit enable row level security;
