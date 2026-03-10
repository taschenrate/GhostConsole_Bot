-- Retention helper for GhostConsole Control Bot.
-- Default retention period: 3 days.

create or replace function public.gc_prune(keep_days integer default 3)
returns table (
  deleted_events bigint,
  deleted_commands bigint,
  deleted_clients bigint
)
language plpgsql
as $$
declare
  cutoff timestamptz;
  events_count bigint := 0;
  commands_count bigint := 0;
  clients_count bigint := 0;
begin
  keep_days := greatest(1, keep_days);
  cutoff := now() - make_interval(days => keep_days);

  with deleted as (
    delete from public.events
    where created_at < cutoff
    returning 1
  )
  select count(*) into events_count from deleted;

  delete from public.balance_snapshots
  where created_at < cutoff;

  with deleted as (
    delete from public.commands
    where created_at < cutoff
    returning 1
  )
  select count(*) into commands_count from deleted;

  with deleted as (
    delete from public.clients
    where last_seen_at < cutoff
    returning 1
  )
  select count(*) into clients_count from deleted;

  return query
  select events_count, commands_count, clients_count;
end;
$$;

-- Manual run:
-- select * from public.gc_prune(3);

-- Optional pg_cron job (if extension enabled):
-- select cron.schedule(
--   'ghostconsole-prune-3d',
--   '0 */6 * * *',
--   $$select * from public.gc_prune(3);$$
-- );
