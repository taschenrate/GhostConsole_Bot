import { config } from "./config.js";
import { fetchUnnotifiedEvents, markEventNotified } from "./supabase.js";

function formatEvent(eventRow) {
  const data = eventRow?.data ?? {};
  const nick = String(data.nick ?? "unknown");
  const clientId = String(eventRow?.client_id ?? "unknown");
  const from = String(data.fromStatus ?? "?");
  const to = String(data.toStatus ?? "?");
  const server = String(data.server ?? "unknown");
  const anarchy = data.anarchyId == null ? null : String(data.anarchyId);

  if (eventRow.type === "entered_hub") {
    return [
      "Уведомление: аккаунт перешел в HUB",
      `Nick: ${nick}`,
      `Client: ${clientId}`,
      `Status: ${from} -> ${to}`,
      `Server: ${server}`
    ].join("\n");
  }

  if (eventRow.type === "entered_menu") {
    return [
      "Уведомление: аккаунт перешел в MENU",
      `Nick: ${nick}`,
      `Client: ${clientId}`,
      `Status: ${from} -> ${to}`,
      `Server: ${server}`
    ].join("\n");
  }

  if (eventRow.type === "entered_anka") {
    return [
      "Уведомление: аккаунт вошел на анархию",
      `Nick: ${nick}`,
      `Client: ${clientId}`,
      `Status: ${from} -> ${to}`,
      `Anarchy: ${anarchy ?? "-"}`,
      `Server: ${server}`
    ].join("\n");
  }

  if (eventRow.type === "command_failed") {
    return [
      "Уведомление: команда завершилась с ошибкой",
      `Client: ${clientId}`,
      `Command ID: ${data.commandId ?? "-"}`,
      `Message: ${data.message ?? "-"}`
    ].join("\n");
  }

  return null;
}

export function startNotifier(bot) {
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const events = await fetchUnnotifiedEvents(100);
      for (const eventRow of events) {
        const message = formatEvent(eventRow);
        if (message) {
          for (const adminId of config.adminIds) {
            try {
              await bot.telegram.sendMessage(adminId, message);
            } catch (sendError) {
              console.error("[notifier] send message error", sendError);
            }
          }
        }
        try {
          await markEventNotified(eventRow.id);
        } catch (markError) {
          console.error("[notifier] mark event error", markError);
        }
      }
    } catch (error) {
      console.error("[notifier] tick error", error);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, config.statusPollMs);
  timer.unref?.();

  void tick();

  return {
    async stop() {
      clearInterval(timer);
    }
  };
}
