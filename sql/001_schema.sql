-- GhostConsole Control Bot schema (Supabase / PostgreSQL)
-- Apply in SQL editor before starting the bot.

create table if not exists public.clients (
  id bigserial primary key,
  client_id text not null unique,
  nick text not null default 'unknown',
  group_name text not null default 'default',
  status text not null default 'MENU' check (status in ('ANKA', 'HUB', 'MENU')),
  anarchy_id text null,
  balance bigint null,
  mode text not null default 'normal' check (mode in ('normal', 'hidden')),
  window_hidden boolean not null default false,
  server text not null default 'unknown',
  ping_ms integer null,
  used_memory_mb integer null,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_clients_group_name on public.clients (group_name);
create index if not exists idx_clients_status on public.clients (status);
create index if not exists idx_clients_last_seen_at on public.clients (last_seen_at desc);
create index if not exists idx_clients_nick on public.clients (nick);

create table if not exists public.commands (
  id bigserial primary key,
  created_by text not null,
  source_target_type text not null check (source_target_type in ('client', 'group', 'all')),
  source_target_value text not null default '',
  command text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_commands_created_at on public.commands (created_at desc);

create table if not exists public.command_targets (
  id bigserial primary key,
  command_id bigint not null references public.commands (id) on delete cascade,
  client_id text not null,
  status text not null default 'pending' check (status in ('pending', 'delivered', 'done', 'failed')),
  assigned_at timestamptz not null default now(),
  delivered_at timestamptz null,
  done_at timestamptz null,
  latency_ms integer null,
  last_error text null,
  unique (command_id, client_id)
);

create index if not exists idx_command_targets_client_status on public.command_targets (client_id, status, command_id);

create table if not exists public.command_results (
  id bigserial primary key,
  command_id bigint not null references public.commands (id) on delete cascade,
  client_id text not null,
  ok boolean not null,
  message text not null default '',
  latency_ms integer null,
  created_at timestamptz not null default now(),
  unique (command_id, client_id)
);

create index if not exists idx_command_results_client on public.command_results (client_id, id desc);

create table if not exists public.balance_snapshots (
  id bigserial primary key,
  client_id text not null,
  balance bigint not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_balance_snapshots_client_time on public.balance_snapshots (client_id, created_at);
create index if not exists idx_balance_snapshots_time on public.balance_snapshots (created_at desc);

create table if not exists public.events (
  id bigserial primary key,
  client_id text null,
  type text not null,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  notified boolean not null default false,
  notified_at timestamptz null
);

create index if not exists idx_events_notified on public.events (notified, id);
create index if not exists idx_events_created_at on public.events (created_at desc);
