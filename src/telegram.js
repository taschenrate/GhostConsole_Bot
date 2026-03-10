import { Markup, Telegraf } from "telegraf";
import { config } from "./config.js";
import {
  createCommandAndTargets,
  fetchClientsPage,
  fetchGroupsSummary,
  fetchRecentCommandResults,
  fetchSummary,
  getClientByDbId,
  resolveClientTarget
} from "./supabase.js";

const SUPPORTED_COMMANDS = new Set([
  "help",
  "status",
  "show",
  "hide",
  "stop",
  "fps",
  "optimize",
  "restore",
  "info",
  "server",
  "player",
  "ping",
  "memory",
  "gc",
  "reconnect",
  "chat",
  "execbind"
]);

function isAdmin(ctx) {
  const id = Number(ctx?.from?.id ?? 0);
  return config.adminIds.includes(id);
}

function adminOnly() {
  return async (ctx, next) => {
    if (!isAdmin(ctx)) {
      return;
    }
    await next();
  };
}

function extractCommandArgs(text) {
  return String(text ?? "").replace(/^\/\S+\s*/u, "").trim();
}

function truncate(value, max) {
  const text = String(value ?? "");
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function formatMoney(value) {
  if (!Number.isFinite(Number(value))) return "-";
  return Number(value).toLocaleString("ru-RU");
}

function isOffline(row) {
  const seenAt = new Date(row?.last_seen_at ?? 0).getTime();
  if (!Number.isFinite(seenAt)) return true;
  return Date.now() - seenAt > config.offlineTimeoutMs;
}

function statusLabel(row) {
  if (isOffline(row)) return "OFFLINE";
  return row?.status ?? "MENU";
}

function secondsAgo(isoValue) {
  const timestamp = new Date(isoValue ?? 0).getTime();
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
}

function formatClientLine(row) {
  const age = secondsAgo(row.last_seen_at);
  const ageText = age == null ? "?" : `${age}s`;
  const anarchyPart = row.anarchy_id ? `A${row.anarchy_id}` : "-";
  return `#${row.id} ${truncate(row.nick, 14)} | ${statusLabel(row)} | ${anarchyPart} | ${formatMoney(row.balance)} | ${row.mode} | ${ageText}`;
}

function commandHelpText() {
  return [
    "Команды бота:",
    "/list [page] - список аккаунтов",
    "/summary - общая сводка",
    "/client <id|nick|client_id> - карточка аккаунта",
    "/do <target> <command> [arg] - универсальная команда",
    "/all <command> [arg] - отправить всем",
    "/group <group> <command> [arg] - отправить группе",
    "/show <target>, /hide <target>, /status <target>, /optimize <target>",
    "/restore <target>, /stop <target>, /ping <target>, /memory <target>",
    "/chat <target> <text> - отправить текст в чат",
    "",
    "target:",
    "id из /list, nick, client_id, all, group:<name>",
    "",
    "Примеры:",
    "/show 12",
    "/do group:farm optimize",
    "/all status",
    "/chat 7 /spawn"
  ].join("\n");
}

function parseTargetSpec(rawTarget) {
  const target = String(rawTarget ?? "").trim();
  if (!target) {
    throw new Error("Target is required");
  }

  if (target.toLowerCase() === "all") {
    return { targetType: "all", targetValue: "" };
  }
  if (target.toLowerCase().startsWith("group:")) {
    const value = target.slice("group:".length).trim();
    if (!value) {
      throw new Error("Group name is empty");
    }
    return { targetType: "group", targetValue: value };
  }

  return { targetType: "client", targetValue: target };
}

function parseCommandAndPayload(command, restArg) {
  const normalized = String(command ?? "").trim().toLowerCase();
  if (!SUPPORTED_COMMANDS.has(normalized)) {
    throw new Error(`Unsupported command: ${normalized}`);
  }
  if (normalized === "chat") {
    const text = String(restArg ?? "").trim();
    if (!text) {
      throw new Error("chat command requires text");
    }
    return { command: normalized, payload: { text } };
  }
  return { command: normalized, payload: {} };
}

async function enqueueCommandFromSpec({ adminId, targetSpec, command, restArg }) {
  const { targetType, targetValue } = parseTargetSpec(targetSpec);
  const parsed = parseCommandAndPayload(command, restArg);
  return await createCommandAndTargets({
    createdBy: adminId,
    targetType,
    targetValue,
    command: parsed.command,
    payload: parsed.payload
  });
}

function buildListKeyboard(rows, page, pageCount) {
  const buttons = rows.map((row) => [Markup.button.callback(`#${row.id} ${truncate(row.nick, 12)}`, `op:${row.id}:${page}`)]);
  buttons.push([
    Markup.button.callback("<<", `pg:${Math.max(1, page - 1)}`),
    Markup.button.callback(`Стр ${page}/${pageCount}`, `pg:${page}`),
    Markup.button.callback(">>", `pg:${Math.min(pageCount, page + 1)}`)
  ]);
  return Markup.inlineKeyboard(buttons);
}

function buildClientKeyboard(row, page) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Показать", `ac:show:${row.id}:${page}`), Markup.button.callback("Скрыть", `ac:hide:${row.id}:${page}`)],
    [Markup.button.callback("Статус", `ac:status:${row.id}:${page}`), Markup.button.callback("Инфо", `ac:info:${row.id}:${page}`)],
    [Markup.button.callback("Опт.", `ac:optimize:${row.id}:${page}`), Markup.button.callback("Restore", `ac:restore:${row.id}:${page}`)],
    [Markup.button.callback("Stop", `ac:stop:${row.id}:${page}`)],
    [Markup.button.callback("Обновить", `rf:${row.id}:${page}`), Markup.button.callback("Назад", `pg:${page}`)]
  ]);
}

async function safeEditOrReply(ctx, text, extra) {
  try {
    if (ctx.updateType === "callback_query") {
      await ctx.editMessageText(text, extra);
      return;
    }
  } catch (_error) {
    // Fall through to regular reply if edit failed.
  }
  await ctx.reply(text, extra);
}

async function renderList(ctx, page) {
  const paged = await fetchClientsPage(page, 12);
  const rows = paged.rows;
  const lines = [
    `Аккаунты: ${paged.total}`,
    `Страница: ${paged.page}/${paged.pageCount}`,
    ""
  ];
  if (rows.length === 0) {
    lines.push("Список пуст.");
  } else {
    for (const row of rows) {
      lines.push(formatClientLine(row));
    }
  }
  await safeEditOrReply(ctx, lines.join("\n"), buildListKeyboard(rows, paged.page, paged.pageCount));
}

function formatResultLine(resultRow) {
  const ok = resultRow.ok ? "OK" : "FAIL";
  const latency = Number.isFinite(resultRow.latency_ms) ? `${resultRow.latency_ms}ms` : "-";
  const msg = truncate(resultRow.message ?? "", 80);
  return `${ok} cmd#${resultRow.command_id} ${latency} ${msg}`;
}

async function renderClientCard(ctx, clientRow, page) {
  const results = await fetchRecentCommandResults(clientRow.client_id, 5);
  const ageSec = secondsAgo(clientRow.last_seen_at);
  const lines = [
    `Аккаунт #${clientRow.id}`,
    `Nick: ${clientRow.nick}`,
    `ClientId: ${clientRow.client_id}`,
    `Group: ${clientRow.group_name}`,
    `Status: ${statusLabel(clientRow)}`,
    `Anarchy: ${clientRow.anarchy_id ?? "-"}`,
    `Balance: ${formatMoney(clientRow.balance)}`,
    `Mode: ${clientRow.mode}`,
    `Window hidden: ${Boolean(clientRow.window_hidden)}`,
    `Server: ${clientRow.server ?? "-"}`,
    `Ping: ${Number.isFinite(clientRow.ping_ms) ? `${clientRow.ping_ms}ms` : "-"}`,
    `Memory: ${Number.isFinite(clientRow.used_memory_mb) ? `${clientRow.used_memory_mb}MB` : "-"}`,
    `Last seen: ${ageSec == null ? "-" : `${ageSec}s ago`}`
  ];
  if (results.length > 0) {
    lines.push("");
    lines.push("Последние результаты:");
    for (const item of results) {
      lines.push(formatResultLine(item));
    }
  }

  await safeEditOrReply(ctx, lines.join("\n"), buildClientKeyboard(clientRow, page));
}

async function resolveClientOrThrow(target) {
  const row = await resolveClientTarget(target);
  if (!row) {
    throw new Error(`Client not found: ${target}`);
  }
  return row;
}

function registerSingleTargetCommands(bot) {
  const commands = ["show", "hide", "status", "optimize", "restore", "stop", "ping", "memory", "fps", "info", "server", "player", "gc", "execbind"];
  for (const commandName of commands) {
    bot.command(commandName, async (ctx) => {
      try {
        const args = extractCommandArgs(ctx.message?.text);
        if (!args) {
          await ctx.reply(`Usage: /${commandName} <target>`);
          return;
        }
        const result = await enqueueCommandFromSpec({
          adminId: ctx.from.id,
          targetSpec: args,
          command: commandName,
          restArg: ""
        });
        await ctx.reply(`queued command #${result.commandId} -> ${result.recipients.length} client(s)`);
      } catch (error) {
        await ctx.reply(`error: ${error.message}`);
      }
    });
  }
}

export function createTelegramBot() {
  const bot = new Telegraf(config.botToken);
  bot.use(adminOnly());

  bot.start(async (ctx) => {
    await ctx.reply(commandHelpText());
    await renderList(ctx, 1);
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(commandHelpText());
  });

  bot.command("list", async (ctx) => {
    const args = extractCommandArgs(ctx.message?.text);
    const page = args ? Math.max(1, Math.trunc(Number(args) || 1)) : 1;
    await renderList(ctx, page);
  });

  bot.command("summary", async (ctx) => {
    const summary = await fetchSummary(config.offlineTimeoutMs);
    const groups = await fetchGroupsSummary();
    const lines = [
      "Сводка:",
      `Всего: ${summary.total}`,
      `Online: ${summary.online}`,
      `Offline: ${summary.offline}`,
      `ANKA: ${summary.anka}`,
      `HUB: ${summary.hub}`,
      `MENU: ${summary.menu}`,
      `Hidden: ${summary.hidden}`,
      `Total balance: ${formatMoney(summary.totalBalance)}`
    ];
    if (groups.length > 0) {
      lines.push("");
      lines.push("Группы:");
      for (const group of groups.slice(0, 10)) {
        lines.push(`${group.groupName}: ${group.total} (A:${group.anka} H:${group.hub} M:${group.menu})`);
      }
    }
    await ctx.reply(lines.join("\n"));
  });

  bot.command("client", async (ctx) => {
    try {
      const args = extractCommandArgs(ctx.message?.text);
      if (!args) {
        await ctx.reply("Usage: /client <id|nick|client_id>");
        return;
      }
      const row = await resolveClientOrThrow(args);
      await renderClientCard(ctx, row, 1);
    } catch (error) {
      await ctx.reply(`error: ${error.message}`);
    }
  });

  bot.command("do", async (ctx) => {
    try {
      const args = extractCommandArgs(ctx.message?.text);
      const parts = args.split(/\s+/).filter(Boolean);
      if (parts.length < 2) {
        await ctx.reply("Usage: /do <target> <command> [arg]");
        return;
      }
      const targetSpec = parts[0];
      const command = parts[1];
      const restArg = args.split(/\s+/).slice(2).join(" ");
      const result = await enqueueCommandFromSpec({
        adminId: ctx.from.id,
        targetSpec,
        command,
        restArg
      });
      await ctx.reply(`queued command #${result.commandId} -> ${result.recipients.length} client(s)`);
    } catch (error) {
      await ctx.reply(`error: ${error.message}`);
    }
  });

  bot.command("all", async (ctx) => {
    try {
      const args = extractCommandArgs(ctx.message?.text);
      const parts = args.split(/\s+/).filter(Boolean);
      if (parts.length < 1) {
        await ctx.reply("Usage: /all <command> [arg]");
        return;
      }
      const command = parts[0];
      const restArg = args.split(/\s+/).slice(1).join(" ");
      const result = await enqueueCommandFromSpec({
        adminId: ctx.from.id,
        targetSpec: "all",
        command,
        restArg
      });
      await ctx.reply(`queued command #${result.commandId} -> ${result.recipients.length} client(s)`);
    } catch (error) {
      await ctx.reply(`error: ${error.message}`);
    }
  });

  bot.command("group", async (ctx) => {
    try {
      const args = extractCommandArgs(ctx.message?.text);
      const parts = args.split(/\s+/).filter(Boolean);
      if (parts.length < 2) {
        await ctx.reply("Usage: /group <name> <command> [arg]");
        return;
      }
      const groupName = parts[0];
      const command = parts[1];
      const restArg = args.split(/\s+/).slice(2).join(" ");
      const result = await enqueueCommandFromSpec({
        adminId: ctx.from.id,
        targetSpec: `group:${groupName}`,
        command,
        restArg
      });
      await ctx.reply(`queued command #${result.commandId} -> ${result.recipients.length} client(s)`);
    } catch (error) {
      await ctx.reply(`error: ${error.message}`);
    }
  });

  bot.command("chat", async (ctx) => {
    try {
      const args = extractCommandArgs(ctx.message?.text);
      const [target, ...textParts] = args.split(/\s+/).filter(Boolean);
      const text = textParts.join(" ");
      if (!target || !text) {
        await ctx.reply("Usage: /chat <target> <text>");
        return;
      }
      const result = await enqueueCommandFromSpec({
        adminId: ctx.from.id,
        targetSpec: target,
        command: "chat",
        restArg: text
      });
      await ctx.reply(`queued command #${result.commandId} -> ${result.recipients.length} client(s)`);
    } catch (error) {
      await ctx.reply(`error: ${error.message}`);
    }
  });

  registerSingleTargetCommands(bot);

  bot.action(/^pg:(\d+)$/u, async (ctx) => {
    const page = Math.max(1, Math.trunc(Number(ctx.match[1]) || 1));
    await renderList(ctx, page);
    await ctx.answerCbQuery();
  });

  bot.action(/^op:(\d+):(\d+)$/u, async (ctx) => {
    try {
      const id = Math.trunc(Number(ctx.match[1]));
      const page = Math.max(1, Math.trunc(Number(ctx.match[2]) || 1));
      const row = await getClientByDbId(id);
      if (!row) {
        await ctx.answerCbQuery("Client not found");
        return;
      }
      await renderClientCard(ctx, row, page);
      await ctx.answerCbQuery();
    } catch (error) {
      await ctx.answerCbQuery("Error");
      await ctx.reply(`error: ${error.message}`);
    }
  });

  bot.action(/^rf:(\d+):(\d+)$/u, async (ctx) => {
    try {
      const id = Math.trunc(Number(ctx.match[1]));
      const page = Math.max(1, Math.trunc(Number(ctx.match[2]) || 1));
      const row = await getClientByDbId(id);
      if (!row) {
        await ctx.answerCbQuery("Client not found");
        return;
      }
      await renderClientCard(ctx, row, page);
      await ctx.answerCbQuery("Updated");
    } catch (error) {
      await ctx.answerCbQuery("Error");
      await ctx.reply(`error: ${error.message}`);
    }
  });

  bot.action(/^ac:([a-z]+):(\d+):(\d+)$/u, async (ctx) => {
    try {
      const action = String(ctx.match[1]).toLowerCase();
      const id = Math.trunc(Number(ctx.match[2]));
      const page = Math.max(1, Math.trunc(Number(ctx.match[3]) || 1));
      if (!SUPPORTED_COMMANDS.has(action) || action === "chat") {
        await ctx.answerCbQuery("Unsupported action");
        return;
      }

      const row = await getClientByDbId(id);
      if (!row) {
        await ctx.answerCbQuery("Client not found");
        return;
      }

      const queued = await createCommandAndTargets({
        createdBy: ctx.from.id,
        targetType: "client",
        targetValue: String(row.id),
        command: action,
        payload: {}
      });

      await renderClientCard(ctx, row, page);
      await ctx.answerCbQuery(`queued #${queued.commandId}`);
    } catch (error) {
      await ctx.answerCbQuery("Error");
      await ctx.reply(`error: ${error.message}`);
    }
  });

  bot.catch((error) => {
    console.error("[telegram] error", error);
  });

  void bot.telegram
    .setMyCommands([
      { command: "list", description: "Список аккаунтов" },
      { command: "summary", description: "Общая сводка" },
      { command: "client", description: "Карточка аккаунта" },
      { command: "do", description: "Универсальная команда" },
      { command: "all", description: "Команда всем" },
      { command: "group", description: "Команда группе" },
      { command: "chat", description: "Сообщение в чат клиента" }
    ])
    .catch((error) => {
      console.error("[telegram] setMyCommands error", error);
    });

  return bot;
}
