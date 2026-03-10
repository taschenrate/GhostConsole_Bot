# GhostConsole Control Bot

Telegram bot + HTTP API hub for controlling multiple GhostConsole Minecraft clients.

## Features

- Bot control for many accounts from one Telegram chat.
- Account list by numeric DB id.
- Per-account actions: `show`, `hide`, `status`, `optimize`, `restore`, `stop`, etc.
- Group/all broadcast commands.
- Live status from mod (`ANKA` / `HUB` / `MENU`), parsed anarchy id, balance, ping, memory.
- Event notifications when account moves to `HUB` or `MENU`.
- Supabase SQL storage for states, command queue, results, events.
- Railway-ready startup (`npm start`).

## Folder layout

- `src/` - bot + api code
- `sql/001_schema.sql` - required schema
- `sql/002_retention.sql` - optional retention function
- `.env.example` - environment template
- `TECH_SPEC_RU.md` - full technical specification

## Requirements

- Node.js 20+
- Supabase project
- Telegram bot token

## 1) Create DB schema (Supabase)

1. Open Supabase SQL editor.
2. Run `sql/001_schema.sql`.
3. Optional: run `sql/002_retention.sql`.
4. If DB was already initialized before this update, run `sql/003_add_balance_snapshots.sql`.

## 2) Configure env

Copy `.env.example` to `.env` and set values:

- `TELEGRAM_BOT_TOKEN` - token from BotFather.
- `TELEGRAM_ADMIN_IDS` - comma-separated Telegram user ids with access.
- `SUPABASE_URL` - your project URL.
- `SUPABASE_SERVICE_ROLE_KEY` - service role key.
- `CONTROL_API_TOKEN` - shared secret for mod -> API auth.
- `PORT` - API port (Railway provides automatically).
- `STATUS_POLL_MS` - notifier poll interval (recommended `5000`).
- `OFFLINE_TIMEOUT_MS` - account considered offline if no updates (recommended `300000`).
- `STALE_CLIENT_DELETE_MS` - delete client from DB if no updates for this TTL (recommended `300000` = 5 min).
- `STALE_SWEEP_INTERVAL_MS` - stale cleanup interval (recommended `60000`).

## 3) Run locally

```bash
npm install
npm run start
```

## 4) Deploy on Railway

1. Create new Railway service from `control-bot` folder.
2. Build command: `npm install`
3. Start command: `npm start`
4. Add all env vars from `.env.example`.
5. Railway will set `PORT` automatically (leave default fallback in env).
6. Keep service always-on.

## 5) Point mod to API

In Minecraft mod config (`ghostconsole.properties`):

```properties
remoteControlEnabled=true
remoteApiBaseUrl=https://<your-railway-domain>
remoteApiToken=<same CONTROL_API_TOKEN>
remoteStatusIntervalMs=5000
remoteCommandPollIntervalMs=2000
remoteCommandBatchLimit=20
remoteClientGroup=default
```

## 6) Telegram quick usage

- `/list` - accounts list with buttons.
- `/avg` - income card (1h/24h).
- `/client <id>` - account card + action buttons.
- `/show <id>` / `/hide <id>` / `/status <id>`.
- `/group <name> show` - send command to group.
- `/all status` - send command to all clients.
- `/chat <id> <text>` - send in-game chat.

## Notes

- Keep `CONTROL_API_TOKEN` private.
- If you run 20+ clients, recommended status interval is 5s and command poll interval is 2s.
- Retention is 3 days by default in runtime cleanup.
