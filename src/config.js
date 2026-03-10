function required(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value.trim();
}

function parseIds(raw) {
  return raw
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0);
}

function readInt(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.max(1, Math.floor(parsed)) : fallback;
}

export const config = {
  botToken: required("TELEGRAM_BOT_TOKEN"),
  adminIds: parseIds(required("TELEGRAM_ADMIN_IDS")),
  supabaseUrl: required("SUPABASE_URL"),
  supabaseServiceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"),
  controlApiToken: required("CONTROL_API_TOKEN"),
  port: readInt("PORT", 8787),
  statusPollMs: readInt("STATUS_POLL_MS", 5000),
  offlineTimeoutMs: readInt("OFFLINE_TIMEOUT_MS", 20000),
  retentionDays: readInt("RETENTION_DAYS", 3)
};

if (config.adminIds.length === 0) {
  throw new Error("TELEGRAM_ADMIN_IDS must contain at least one numeric id");
}
