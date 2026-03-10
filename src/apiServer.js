import express from "express";
import { config } from "./config.js";
import {
  fetchCommandsForClient,
  insertEvent,
  upsertClientState,
  upsertCommandResult
} from "./supabase.js";

const ALLOWED_STATUS = new Set(["ANKA", "HUB", "MENU"]);

function normalizeStatus(raw) {
  const value = String(raw ?? "").trim().toUpperCase();
  return ALLOWED_STATUS.has(value) ? value : "MENU";
}

function requireToken(req, res, next) {
  const token = String(req.header("x-client-token") ?? "").trim();
  if (!token || token !== config.controlApiToken) {
    res.status(401).json({ ok: false, error: "Unauthorized" });
    return;
  }
  next();
}

function normalizeStatePayload(body) {
  return {
    clientId: String(body?.clientId ?? "").trim(),
    nick: String(body?.nick ?? "unknown").trim() || "unknown",
    groupName: String(body?.groupName ?? "default").trim() || "default",
    status: normalizeStatus(body?.status),
    anarchyId: body?.anarchyId == null ? null : String(body.anarchyId).trim() || null,
    balance: Number.isFinite(Number(body?.balance)) ? Math.trunc(Number(body.balance)) : null,
    mode: String(body?.mode ?? "normal").trim().toLowerCase() === "hidden" ? "hidden" : "normal",
    windowHidden: Boolean(body?.windowHidden),
    server: String(body?.server ?? "unknown").trim() || "unknown",
    pingMs: Number.isFinite(Number(body?.pingMs)) ? Math.trunc(Number(body.pingMs)) : null,
    usedMemoryMb: Number.isFinite(Number(body?.usedMemoryMb)) ? Math.trunc(Number(body.usedMemoryMb)) : null
  };
}

function normalizeCommandResultPayload(body) {
  return {
    clientId: String(body?.clientId ?? "").trim(),
    commandId: Math.trunc(Number(body?.commandId)),
    ok: Boolean(body?.ok),
    message: String(body?.message ?? ""),
    latencyMs: Number.isFinite(Number(body?.latencyMs)) ? Math.max(0, Math.trunc(Number(body.latencyMs))) : null
  };
}

async function pushStatusEvents(previous, current) {
  if (!current) {
    return;
  }
  if (!previous || !previous.status || previous.status === current.status) {
    return;
  }

  const baseData = {
    nick: current.nick,
    fromStatus: previous.status,
    toStatus: current.status,
    server: current.server,
    anarchyId: current.anarchy_id,
    groupName: current.group_name
  };
  await insertEvent({ clientId: current.client_id, type: "status_changed", data: baseData });

  if (current.status === "HUB") {
    await insertEvent({ clientId: current.client_id, type: "entered_hub", data: baseData });
  } else if (current.status === "MENU") {
    await insertEvent({ clientId: current.client_id, type: "entered_menu", data: baseData });
  } else if (current.status === "ANKA") {
    await insertEvent({ clientId: current.client_id, type: "entered_anka", data: baseData });
  }
}

export function createApiServer() {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "ghostconsole-control-bot", now: new Date().toISOString() });
  });

  app.post("/api/client/state", requireToken, async (req, res) => {
    try {
      const payload = normalizeStatePayload(req.body);
      if (!payload.clientId) {
        res.status(400).json({ ok: false, error: "clientId is required" });
        return;
      }

      const { previous, current } = await upsertClientState(payload);
      await pushStatusEvents(previous, current);
      res.json({ ok: true });
    } catch (error) {
      console.error("[api] state error", error);
      res.status(500).json({ ok: false, error: "Internal error" });
    }
  });

  app.get("/api/client/commands", requireToken, async (req, res) => {
    try {
      const clientId = String(req.query.clientId ?? "").trim();
      if (!clientId) {
        res.status(400).json({ ok: false, error: "clientId is required" });
        return;
      }
      const sinceCommandId = Number(req.query.sinceCommandId ?? 0);
      const limit = Number(req.query.limit ?? 20);
      const commands = await fetchCommandsForClient({ clientId, sinceCommandId, limit });
      res.json({ ok: true, commands });
    } catch (error) {
      console.error("[api] commands error", error);
      res.status(500).json({ ok: false, error: "Internal error" });
    }
  });

  app.post("/api/client/command-result", requireToken, async (req, res) => {
    try {
      const payload = normalizeCommandResultPayload(req.body);
      if (!payload.clientId || !Number.isFinite(payload.commandId) || payload.commandId <= 0) {
        res.status(400).json({ ok: false, error: "Invalid payload" });
        return;
      }

      await upsertCommandResult(payload);
      if (!payload.ok) {
        await insertEvent({
          clientId: payload.clientId,
          type: "command_failed",
          data: {
            commandId: payload.commandId,
            message: payload.message
          }
        });
      }

      res.json({ ok: true });
    } catch (error) {
      console.error("[api] command-result error", error);
      res.status(500).json({ ok: false, error: "Internal error" });
    }
  });

  return app;
}
