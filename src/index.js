import { config } from "./config.js";
import { createApiServer } from "./apiServer.js";
import { startNotifier } from "./notifier.js";
import { deleteStaleClients, pruneOldData } from "./supabase.js";
import { createTelegramBot } from "./telegram.js";

const RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000;

const app = createApiServer();
const bot = createTelegramBot();

const server = app.listen(config.port, () => {
  console.log(`[boot] API listening on :${config.port}`);
});

await bot.launch();
console.log("[boot] Telegram bot started");

const notifier = startNotifier(bot);

const staleClientsTimer = setInterval(() => {
  void deleteStaleClients(config.staleClientDeleteMs)
    .then((result) => {
      if (result.deletedClients > 0) {
        console.log(
          `[stale] deleted clients=${result.deletedClients}, events=${result.deletedEvents}, targets=${result.deletedTargets}, results=${result.deletedResults}, snapshots=${result.deletedSnapshots}`
        );
      }
    })
    .catch((error) => {
      console.error("[stale] cleanup error", error);
    });
}, config.staleSweepIntervalMs);
staleClientsTimer.unref?.();

const retentionTimer = setInterval(() => {
  void pruneOldData(config.retentionDays).catch((error) => {
    console.error("[retention] prune error", error);
  });
}, RETENTION_INTERVAL_MS);
retentionTimer.unref?.();

void deleteStaleClients(config.staleClientDeleteMs).catch((error) => {
  console.error("[stale] initial cleanup error", error);
});

void pruneOldData(config.retentionDays).catch((error) => {
  console.error("[retention] initial prune error", error);
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal}`);

  clearInterval(retentionTimer);
  clearInterval(staleClientsTimer);

  try {
    await notifier.stop();
  } catch (error) {
    console.error("[shutdown] notifier stop error", error);
  }

  try {
    bot.stop(signal);
  } catch (error) {
    console.error("[shutdown] bot stop error", error);
  }

  await new Promise((resolve) => {
    server.close(() => resolve());
  });

  process.exit(0);
}

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});
process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});
