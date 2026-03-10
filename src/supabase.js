import { createClient } from "@supabase/supabase-js";
import { config } from "./config.js";

export const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false }
});

function nowIso() {
  return new Date().toISOString();
}

function toMs(value) {
  const ms = new Date(value ?? 0).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function isMissingBalanceSnapshotsError(error) {
  const code = String(error?.code ?? "");
  const message = String(error?.message ?? "").toLowerCase();
  if (code === "42P01" || code === "PGRST205") {
    return true;
  }
  return message.includes("balance_snapshots") && (message.includes("does not exist") || message.includes("schema cache"));
}

function normalizeStatus(raw) {
  const value = String(raw ?? "").trim().toUpperCase();
  if (value === "ANKA" || value === "HUB" || value === "MENU") {
    return value;
  }
  return "MENU";
}

function normalizeMode(raw) {
  const value = String(raw ?? "").trim().toLowerCase();
  return value === "hidden" ? "hidden" : "normal";
}

function normalizeInt(value, fallback = null) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.trunc(number);
}

function normalizeClientState(state) {
  const clientId = String(state.clientId ?? "").trim();
  if (!clientId) {
    throw new Error("clientId is required");
  }
  return {
    client_id: clientId,
    nick: String(state.nick ?? "unknown").trim() || "unknown",
    group_name: String(state.groupName ?? "default").trim() || "default",
    status: normalizeStatus(state.status),
    anarchy_id: state.anarchyId == null ? null : String(state.anarchyId).trim() || null,
    balance: normalizeInt(state.balance, null),
    mode: normalizeMode(state.mode),
    window_hidden: Boolean(state.windowHidden),
    server: String(state.server ?? "unknown").trim() || "unknown",
    ping_ms: normalizeInt(state.pingMs, null),
    used_memory_mb: normalizeInt(state.usedMemoryMb, null),
    last_seen_at: nowIso(),
    updated_at: nowIso()
  };
}

export async function getClientByClientId(clientId) {
  const normalized = String(clientId ?? "").trim();
  if (!normalized) return null;
  const { data, error } = await supabase.from("clients").select("*").eq("client_id", normalized).limit(1);
  if (error) throw error;
  return data?.[0] ?? null;
}

export async function getClientByDbId(id) {
  const numeric = Number(id);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  const { data, error } = await supabase.from("clients").select("*").eq("id", Math.trunc(numeric)).limit(1);
  if (error) throw error;
  return data?.[0] ?? null;
}

export async function upsertClientState(state) {
  const row = normalizeClientState(state);
  const previous = await getClientByClientId(row.client_id);
  const { error } = await supabase.from("clients").upsert(row, { onConflict: "client_id" });
  if (error) throw error;
  const current = await getClientByClientId(row.client_id);
  try {
    await maybeInsertBalanceSnapshot(previous, current);
  } catch (snapshotError) {
    // Do not block state ingestion if snapshot table is not migrated yet.
    if (!isMissingBalanceSnapshotsError(snapshotError)) {
      throw snapshotError;
    }
  }
  return { previous, current };
}

async function maybeInsertBalanceSnapshot(previous, current) {
  if (!current || !Number.isFinite(Number(current.balance))) {
    return;
  }
  const clientId = String(current.client_id);
  const currentBalance = Math.trunc(Number(current.balance));
  const now = Date.now();

  const { data: latestRows, error: latestError } = await supabase
    .from("balance_snapshots")
    .select("balance, created_at")
    .eq("client_id", clientId)
    .order("created_at", { ascending: false })
    .limit(1);
  if (latestError) throw latestError;
  const latest = latestRows?.[0] ?? null;

  const previousBalance = previous && Number.isFinite(Number(previous.balance)) ? Math.trunc(Number(previous.balance)) : null;
  const balanceChanged = previousBalance == null || previousBalance !== currentBalance;
  const latestTs = latest ? toMs(latest.created_at) : 0;
  const latestBalance = latest && Number.isFinite(Number(latest.balance)) ? Math.trunc(Number(latest.balance)) : null;
  const enoughTimePassed = now - latestTs >= 60_000;
  const changedSinceLatest = latestBalance == null || latestBalance !== currentBalance;

  if (!latest || (changedSinceLatest && (balanceChanged || enoughTimePassed))) {
    const { error: insertError } = await supabase.from("balance_snapshots").insert({
      client_id: clientId,
      balance: currentBalance,
      created_at: nowIso()
    });
    if (insertError) throw insertError;
  }
}

export async function fetchClientsPage(page = 1, pageSize = 15) {
  const safePage = Math.max(1, Math.trunc(Number(page) || 1));
  const safePageSize = Math.min(50, Math.max(1, Math.trunc(Number(pageSize) || 15)));
  const from = (safePage - 1) * safePageSize;
  const to = from + safePageSize - 1;

  const { data, error, count } = await supabase
    .from("clients")
    .select("*", { count: "exact" })
    .order("id", { ascending: true })
    .range(from, to);
  if (error) throw error;
  const total = Number(count ?? 0);
  return {
    rows: data ?? [],
    total,
    page: safePage,
    pageSize: safePageSize,
    pageCount: Math.max(1, Math.ceil(total / safePageSize))
  };
}

export async function fetchClients(limit = 500) {
  const safeLimit = Math.min(2_000, Math.max(1, Math.trunc(Number(limit) || 500)));
  const { data, error } = await supabase.from("clients").select("*").order("id", { ascending: true }).limit(safeLimit);
  if (error) throw error;
  return data ?? [];
}

export async function fetchSummary(offlineTimeoutMs) {
  const rows = await fetchClients(2_000);
  const now = Date.now();
  const timeout = Math.max(1_000, Number(offlineTimeoutMs) || 20_000);

  let online = 0;
  let offline = 0;
  let anka = 0;
  let hub = 0;
  let menu = 0;
  let hidden = 0;
  let totalBalance = 0;

  for (const row of rows) {
    const seenAt = new Date(row.last_seen_at ?? 0).getTime();
    const isOffline = !Number.isFinite(seenAt) || now - seenAt > timeout;
    if (isOffline) {
      offline += 1;
    } else {
      online += 1;
      if (row.status === "ANKA") anka += 1;
      if (row.status === "HUB") hub += 1;
      if (row.status === "MENU") menu += 1;
    }
    if (row.mode === "hidden") hidden += 1;
    if (Number.isFinite(row.balance)) {
      totalBalance += Number(row.balance);
    }
  }

  return { total: rows.length, online, offline, anka, hub, menu, hidden, totalBalance };
}

function pickClientPool(clients, snapshots24, offlineTimeoutMs) {
  const now = Date.now();
  const timeout = Math.max(1_000, Number(offlineTimeoutMs) || 20_000);
  const staleWarningMs = 60 * 60 * 1_000;

  const active = clients.filter((row) => now - toMs(row.last_seen_at) <= timeout);
  const staleByHour = clients.filter((row) => now - toMs(row.last_seen_at) > staleWarningMs);
  const snapshotClientIds = new Set(snapshots24.map((item) => String(item.client_id)));
  const from24h = clients.filter((row) => snapshotClientIds.has(String(row.client_id)));

  const selected = active.length > 0 ? active : from24h;
  return {
    selected,
    fallbackUsed: active.length === 0,
    staleWarning: staleByHour.length === clients.length && clients.length > 0
  };
}

function buildBaselineMaps(snapshots24, cutoff1hMs) {
  const baseline24 = new Map();
  const baseline1 = new Map();
  for (const item of snapshots24) {
    const clientId = String(item.client_id);
    const balance = Number(item.balance);
    if (!Number.isFinite(balance)) {
      continue;
    }
    if (!baseline24.has(clientId)) {
      baseline24.set(clientId, Math.trunc(balance));
    }
    const ts = toMs(item.created_at);
    if (ts >= cutoff1hMs && !baseline1.has(clientId)) {
      baseline1.set(clientId, Math.trunc(balance));
    }
  }
  return { baseline24, baseline1 };
}

function statusText(client) {
  const status = String(client?.status ?? "MENU");
  if (status === "ANKA") {
    return client?.anarchy_id ? `на анке #${client.anarchy_id}` : "на анке";
  }
  if (status === "HUB") {
    return "в хабе";
  }
  return "вне сервера";
}

export async function fetchDashboardStats(offlineTimeoutMs) {
  const clients = await fetchClients(2_000);
  const now = Date.now();
  const cutoff24hMs = now - 24 * 60 * 60 * 1_000;
  const cutoff1hMs = now - 60 * 60 * 1_000;
  const cutoff24hIso = new Date(cutoff24hMs).toISOString();

  let snapshotRows = [];
  try {
    const { data: snapshots24, error: snapshotsError } = await supabase
      .from("balance_snapshots")
      .select("client_id, balance, created_at")
      .gte("created_at", cutoff24hIso)
      .order("created_at", { ascending: true })
      .limit(300_000);
    if (snapshotsError) throw snapshotsError;
    snapshotRows = snapshots24 ?? [];
  } catch (snapshotError) {
    if (!isMissingBalanceSnapshotsError(snapshotError)) {
      throw snapshotError;
    }
  }

  const pools = pickClientPool(clients, snapshotRows, offlineTimeoutMs);
  const { baseline24, baseline1 } = buildBaselineMaps(snapshotRows, cutoff1hMs);

  let income1hTotal = 0;
  let income24hTotal = 0;
  let calcInstances = 0;

  for (const client of pools.selected) {
    const current = Number(client.balance);
    if (!Number.isFinite(current)) {
      continue;
    }
    const clientId = String(client.client_id);
    const base24 = baseline24.has(clientId) ? Number(baseline24.get(clientId)) : current;
    const base1 = baseline1.has(clientId) ? Number(baseline1.get(clientId)) : current;

    income24hTotal += Math.trunc(current - base24);
    income1hTotal += Math.trunc(current - base1);
    calcInstances += 1;
  }

  const statusRows = pools.selected
    .slice()
    .sort((a, b) => String(a.nick ?? "").localeCompare(String(b.nick ?? ""), "ru"))
    .slice(0, 25)
    .map((client) => ({
      nick: String(client.nick ?? "unknown"),
      statusText: statusText(client),
      ageSec: Math.max(0, Math.floor((now - toMs(client.last_seen_at)) / 1000)),
      balance: Number.isFinite(Number(client.balance)) ? Math.trunc(Number(client.balance)) : null
    }));

  const totalBalance = pools.selected.reduce((acc, client) => {
    const value = Number(client.balance);
    return Number.isFinite(value) ? acc + Math.trunc(value) : acc;
  }, 0);

  return {
    generatedAt: new Date(now).toISOString(),
    calcInstances,
    income1hTotal,
    income24hTotal,
    income1hPerAcc: calcInstances > 0 ? Math.trunc(income1hTotal / calcInstances) : 0,
    income24hPerAcc: calcInstances > 0 ? Math.trunc(income24hTotal / calcInstances) : 0,
    totalBalance,
    staleWarning: pools.staleWarning,
    fallbackTo24h: pools.fallbackUsed,
    statusRows
  };
}

export async function resolveClientTarget(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return null;

  if (/^\d+$/.test(normalized)) {
    const byDbId = await getClientByDbId(Number(normalized));
    if (byDbId) return byDbId;
  }

  const { data: byClientId, error: byClientIdError } = await supabase
    .from("clients")
    .select("*")
    .ilike("client_id", normalized)
    .order("last_seen_at", { ascending: false })
    .limit(1);
  if (byClientIdError) throw byClientIdError;
  if (byClientId?.[0]) return byClientId[0];

  const { data: byNick, error: byNickError } = await supabase
    .from("clients")
    .select("*")
    .ilike("nick", normalized)
    .order("last_seen_at", { ascending: false })
    .limit(1);
  if (byNickError) throw byNickError;
  if (byNick?.[0]) return byNick[0];

  return null;
}

export async function fetchRecentCommandResults(clientId, limit = 10) {
  const safeLimit = Math.min(50, Math.max(1, Math.trunc(Number(limit) || 10)));
  const { data, error } = await supabase
    .from("command_results")
    .select("id, command_id, client_id, ok, message, latency_ms, created_at")
    .eq("client_id", String(clientId))
    .order("id", { ascending: false })
    .limit(safeLimit);
  if (error) throw error;
  return data ?? [];
}

export async function fetchGroupsSummary() {
  const rows = await fetchClients(2_000);
  const groups = new Map();
  for (const row of rows) {
    const name = String(row.group_name ?? "default");
    if (!groups.has(name)) {
      groups.set(name, { groupName: name, total: 0, anka: 0, hub: 0, menu: 0 });
    }
    const item = groups.get(name);
    item.total += 1;
    if (row.status === "ANKA") item.anka += 1;
    if (row.status === "HUB") item.hub += 1;
    if (row.status === "MENU") item.menu += 1;
  }
  return Array.from(groups.values()).sort((a, b) => a.groupName.localeCompare(b.groupName));
}

async function resolveTargets(targetType, targetValue) {
  const type = String(targetType ?? "").toLowerCase().trim();
  const raw = String(targetValue ?? "").trim();

  if (type === "all") {
    return await fetchClients(2_000);
  }

  if (type === "group") {
    if (!raw) {
      return [];
    }
    const { data, error } = await supabase
      .from("clients")
      .select("*")
      .ilike("group_name", raw)
      .order("id", { ascending: true })
      .limit(2_000);
    if (error) throw error;
    return data ?? [];
  }

  if (type === "client") {
    const row = await resolveClientTarget(raw);
    return row ? [row] : [];
  }

  throw new Error(`Unsupported targetType: ${targetType}`);
}

export async function createCommandAndTargets({ createdBy, targetType, targetValue, command, payload }) {
  const normalizedCommand = String(command ?? "").trim().toLowerCase();
  if (!normalizedCommand) {
    throw new Error("command is required");
  }

  const recipients = await resolveTargets(targetType, targetValue);
  if (recipients.length === 0) {
    throw new Error("No recipients found for target");
  }

  const { data: commandRow, error: commandError } = await supabase
    .from("commands")
    .insert({
      created_by: String(createdBy),
      source_target_type: String(targetType).toLowerCase(),
      source_target_value: String(targetValue ?? ""),
      command: normalizedCommand,
      payload: payload ?? {},
      created_at: nowIso()
    })
    .select("id")
    .single();
  if (commandError) throw commandError;

  const targetsToInsert = recipients.map((row) => ({
    command_id: commandRow.id,
    client_id: String(row.client_id),
    status: "pending",
    assigned_at: nowIso()
  }));

  const { error: targetsError } = await supabase.from("command_targets").insert(targetsToInsert);
  if (targetsError) throw targetsError;

  return {
    commandId: commandRow.id,
    recipients: recipients.map((row) => ({
      id: row.id,
      clientId: row.client_id,
      nick: row.nick
    }))
  };
}

export async function fetchCommandsForClient({ clientId, sinceCommandId, limit }) {
  const normalizedClientId = String(clientId ?? "").trim();
  if (!normalizedClientId) {
    return [];
  }

  const safeSince = Number.isFinite(sinceCommandId) ? Math.max(0, Math.trunc(sinceCommandId)) : 0;
  const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), 100) : 20;
  const redeliveryCutoff = Date.now() - 30_000;

  const { data, error } = await supabase
    .from("command_targets")
    .select("command_id, status, delivered_at, commands!inner(id, command, payload)")
    .eq("client_id", normalizedClientId)
    .gt("command_id", safeSince)
    .in("status", ["pending", "delivered"])
    .order("command_id", { ascending: true })
    .limit(safeLimit * 4);
  if (error) throw error;

  const selected = [];
  const seen = new Set();
  for (const row of data ?? []) {
    const commandId = Number(row.command_id);
    if (!Number.isFinite(commandId) || seen.has(commandId)) {
      continue;
    }

    const status = String(row.status ?? "");
    if (status === "delivered") {
      const deliveredAtMs = new Date(row.delivered_at ?? 0).getTime();
      if (Number.isFinite(deliveredAtMs) && deliveredAtMs > redeliveryCutoff) {
        continue;
      }
    }

    selected.push(row);
    seen.add(commandId);
    if (selected.length >= safeLimit) {
      break;
    }
  }

  const pendingCommandIds = selected
    .filter((row) => row.status === "pending")
    .map((row) => Number(row.command_id))
    .filter((id) => Number.isFinite(id));

  if (pendingCommandIds.length > 0) {
    const { error: updateError } = await supabase
      .from("command_targets")
      .update({ status: "delivered", delivered_at: nowIso() })
      .eq("client_id", normalizedClientId)
      .eq("status", "pending")
      .in("command_id", pendingCommandIds);
    if (updateError) throw updateError;
  }

  return selected.map((row) => ({
    id: Number(row.command_id),
    command: row.commands.command,
    payload: row.commands.payload ?? {}
  }));
}

export async function upsertCommandResult({ commandId, clientId, ok, message, latencyMs }) {
  const normalizedClientId = String(clientId ?? "").trim();
  const normalizedCommandId = Math.trunc(Number(commandId));
  if (!normalizedClientId || !Number.isFinite(normalizedCommandId) || normalizedCommandId <= 0) {
    throw new Error("Invalid command result payload");
  }

  const row = {
    command_id: normalizedCommandId,
    client_id: normalizedClientId,
    ok: Boolean(ok),
    message: String(message ?? ""),
    latency_ms: normalizeInt(latencyMs, null),
    created_at: nowIso()
  };
  const { error } = await supabase.from("command_results").upsert(row, { onConflict: "command_id,client_id" });
  if (error) throw error;

  const targetPatch = {
    status: row.ok ? "done" : "failed",
    done_at: nowIso(),
    latency_ms: row.latency_ms,
    last_error: row.ok ? null : row.message
  };
  const { error: targetError } = await supabase
    .from("command_targets")
    .update(targetPatch)
    .eq("command_id", normalizedCommandId)
    .eq("client_id", normalizedClientId);
  if (targetError) throw targetError;
}

export async function insertEvent({ clientId, type, data }) {
  const row = {
    client_id: clientId == null ? null : String(clientId),
    type: String(type),
    data: data ?? {},
    created_at: nowIso(),
    notified: false
  };
  const { data: inserted, error } = await supabase.from("events").insert(row).select("id").single();
  if (error) throw error;
  return inserted.id;
}

export async function fetchUnnotifiedEvents(limit = 100) {
  const safeLimit = Math.min(500, Math.max(1, Math.trunc(Number(limit) || 100)));
  const { data: events, error: eventsError } = await supabase
    .from("events")
    .select("*")
    .eq("notified", false)
    .order("id", { ascending: true })
    .limit(safeLimit);
  if (eventsError) throw eventsError;
  return events ?? [];
}

export async function markEventNotified(eventId) {
  const { error } = await supabase
    .from("events")
    .update({ notified: true, notified_at: nowIso() })
    .eq("id", Number(eventId));
  if (error) throw error;
}

export async function pruneOldData(keepDays = 3) {
  const days = Math.max(1, Math.trunc(Number(keepDays) || 3));
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const { error: deleteEventsError } = await supabase.from("events").delete().lt("created_at", cutoff);
  if (deleteEventsError) throw deleteEventsError;

  const { error: deleteSnapshotsError } = await supabase.from("balance_snapshots").delete().lt("created_at", cutoff);
  if (deleteSnapshotsError) throw deleteSnapshotsError;

  // Cascades to command_targets and command_results via FK in SQL schema.
  const { error: deleteCommandsError } = await supabase.from("commands").delete().lt("created_at", cutoff);
  if (deleteCommandsError) throw deleteCommandsError;

  // Optional: remove stale clients that were not seen recently.
  const { error: deleteClientsError } = await supabase.from("clients").delete().lt("last_seen_at", cutoff);
  if (deleteClientsError) throw deleteClientsError;
}

export async function fetchCommandById(commandId) {
  const normalizedCommandId = Number(commandId);
  if (!Number.isFinite(normalizedCommandId)) {
    return null;
  }
  const { data, error } = await supabase
    .from("commands")
    .select("id, command, payload, created_by, source_target_type, source_target_value, created_at")
    .eq("id", Math.trunc(normalizedCommandId))
    .limit(1);
  if (error) throw error;
  return data?.[0] ?? null;
}
