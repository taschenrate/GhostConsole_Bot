-- Migration for existing projects:
-- adds balance snapshots table used by /avg and enhanced /summary.

create table if not exists public.balance_snapshots (
  id bigserial primary key,
  client_id text not null,
  balance bigint not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_balance_snapshots_client_time on public.balance_snapshots (client_id, created_at);
create index if not exists idx_balance_snapshots_time on public.balance_snapshots (created_at desc);
