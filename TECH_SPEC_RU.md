# Техническое задание: GhostConsole Telegram Control Bot

## 1. Цель

Сделать отдельный сервис (`control-bot`) для централизованного управления множеством Minecraft-клиентов с модом GhostConsole через Telegram.

Сервис должен:

- принимать статусы от модов по HTTP;
- хранить состояние аккаунтов в SQL (Supabase);
- отправлять команды модам через очередь;
- показывать сводку по всем аккаунтам (баланс, анархия, статус);
- уведомлять в Telegram при переходе аккаунта в `HUB` / `MENU`;
- быть готовым к хостингу на Railway.

## 2. Архитектура

Компоненты:

1. `Fabric мод` (клиент):
   - пушит статус в API (`/api/client/state`);
   - получает команды (`/api/client/commands`);
   - отправляет результат выполнения (`/api/client/command-result`).
2. `Control Bot` (Node.js):
   - HTTP API для модов;
   - Telegram bot (Telegraf) для оператора;
   - логика очереди и маршрутизации команд.
3. `Supabase (PostgreSQL)`:
   - `clients` (последний статус клиента);
   - `commands` + `command_targets` (очередь команд);
   - `command_results` (результаты выполнения);
   - `events` (события/уведомления).

## 3. Функциональные требования

### 3.1 Учет аккаунтов

- Каждый клиент имеет стабильный `client_id`.
- В БД хранится `id` (numeric), `nick`, `group_name`, `status`, `anarchy_id`, `balance`, `mode`, `last_seen_at`.
- Список в Telegram отображается по `id` (числовому).

### 3.2 Статусы

Поддерживаемые статусы:

- `ANKA` - клиент на анархии (номер анархии парсится с борда модом).
- `HUB` - подключен, но анархия не обнаружена (хаб/лобби).
- `MENU` - нет подключения к серверу.
- `OFFLINE` - вычисляется ботом по timeout (`OFFLINE_TIMEOUT_MS`).

### 3.3 Команды управления

Поддержка команд мода:

- `help`, `status`, `show`, `hide`, `stop`, `fps`, `optimize`, `restore`, `info`, `server`, `player`, `ping`, `memory`, `gc`, `reconnect`, `chat`, `execbind`.

Таргеты:

- `client` (по `id`, `nick` или `client_id`);
- `group` (`group:<name>`);
- `all`.

### 3.4 Telegram интерфейс

Обязательные команды:

- `/list [page]`
- `/summary`
- `/client <id|nick|client_id>`
- `/do <target> <command> [arg]`
- `/all <command> [arg]`
- `/group <group> <command> [arg]`
- `/chat <target> <text>`
- shortcuts: `/show`, `/hide`, `/status`, `/optimize`, `/restore`, `/stop` и др.

Inline-кнопки:

- переход в карточку аккаунта;
- действия `show/hide/status/info/optimize/restore/stop`;
- навигация по страницам.

### 3.5 Уведомления

При смене статуса клиента:

- `status_changed` логируется в `events`;
- если целевой статус `HUB` -> создается `entered_hub`;
- если `MENU` -> `entered_menu`;
- если `ANKA` -> `entered_anka`.

Нотификатор отправляет события администраторам Telegram.

### 3.6 Безопасность

- API модов защищен заголовком `x-client-token`.
- Токен должен совпадать с `CONTROL_API_TOKEN`.
- Telegram доступ только для `TELEGRAM_ADMIN_IDS`.

## 4. API контракт

### POST `/api/client/state`

Вход:

```json
{
  "clientId": "nick-abc12345",
  "nick": "Nick",
  "groupName": "default",
  "status": "ANKA",
  "anarchyId": "102",
  "balance": 1234567,
  "mode": "hidden",
  "windowHidden": true,
  "server": "example.net",
  "pingMs": 55,
  "usedMemoryMb": 800
}
```

Выход:

```json
{ "ok": true }
```

### GET `/api/client/commands`

Query:

- `clientId`
- `sinceCommandId`
- `limit`

Выход:

```json
{
  "ok": true,
  "commands": [
    { "id": 101, "command": "hide", "payload": {} },
    { "id": 102, "command": "chat", "payload": { "text": "/spawn" } }
  ]
}
```

### POST `/api/client/command-result`

Вход:

```json
{
  "clientId": "nick-abc12345",
  "commandId": 101,
  "ok": true,
  "message": "Hide requested",
  "latencyMs": 15
}
```

Выход:

```json
{ "ok": true }
```

## 5. Производительность и масштаб

Целевой сценарий: 20+ клиентов одновременно.

Рекомендации:

- `remoteStatusIntervalMs = 5000`
- `remoteCommandPollIntervalMs = 2000`
- `remoteCommandBatchLimit = 20`
- Telegram polling и notifier не должны блокировать API.

Очередь построена через `commands + command_targets`, чтобы одна команда могла безопасно разойтись на много клиентов.

## 6. Retention

- Хранение истории: 3 дня.
- Runtime cleanup в `index.js` (каждые 6 часов).
- SQL-функция `gc_prune(keep_days)` в `sql/002_retention.sql`.

## 7. Хостинг Railway

Требования:

- Node.js 20.
- Start command: `npm start`.
- Environment variables из `.env.example`.

Сервис должен быть one-process: API + Telegram bot + notifier в одном инстансе.

## 8. Готовность

Решение считается готовым, если:

- моды стабильно репортят статус в API;
- команды из Telegram доходят до нужных клиентов;
- список аккаунтов и сводка отражают реальное состояние;
- уведомления `HUB/MENU` приходят администраторам;
- сервис корректно работает на Railway + Supabase.
