-- Staff AI assistant (dashboard chat) — settings, per-staff chat history, audit source.
--
-- The dashboard gets an assistant that answers ops questions by calling the same
-- read-only tools as the staff MCP server, as the logged-in staff member (limited
-- to their staff_role). This migration adds:
--   * ai_settings.assistant_enabled / assistant_provider / assistant_model
--     (model null -> server default)
--   * staff_mcp_audit.source ('mcp' | 'assistant') so assistant tool calls are
--     distinguishable in the audit trail
--   * staff_assistant_threads / staff_assistant_messages — private per-staff chat
--     history. assistant turns that requested tools keep them in tool_calls
--     ([{id,name,arguments}]); tool results are stored as role='tool' rows.
-- Both history tables are service-role only: RLS on, no client policies.

alter table public.ai_settings
  add column if not exists assistant_enabled boolean not null default true,
  add column if not exists assistant_provider text not null default 'openrouter',
  add column if not exists assistant_model text;

alter table public.staff_mcp_audit
  add column if not exists source text not null default 'mcp';

create table if not exists public.staff_assistant_threads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  title text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_staff_assistant_threads_user
  on public.staff_assistant_threads (user_id, updated_at desc);

drop trigger if exists trg_staff_assistant_threads_updated_at on public.staff_assistant_threads;
create trigger trg_staff_assistant_threads_updated_at
  before update on public.staff_assistant_threads
  for each row execute function update_updated_at();

alter table public.staff_assistant_threads enable row level security;

create table if not exists public.staff_assistant_messages (
  id bigint generated always as identity primary key,
  thread_id uuid not null references public.staff_assistant_threads(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'tool')),
  content text not null default '',
  tool_calls jsonb,
  tool_call_id text,
  tool_name text,
  tool_ok boolean,
  row_count int,
  created_at timestamptz not null default now()
);

create index if not exists idx_staff_assistant_messages_thread
  on public.staff_assistant_messages (thread_id, id);

alter table public.staff_assistant_messages enable row level security;
