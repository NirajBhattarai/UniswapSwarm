import express, { type Request, type Response } from "express";
import { SwarmOrchestrator } from "./orchestrator";
import { getConfig, logger } from "@swarm/shared";
import type { SwarmEvent } from "@swarm/shared";

export function createServer(orchestrator: SwarmOrchestrator): express.Application {
  const app = express();
  app.use(express.json());

  // ── Health ────────────────────────────────────────────────────────────────────
  app.get("/health", (_req: Request, res: Response): void => {
    res.json({ status: "ok", running: orchestrator.isRunning() });
  });

  // ── Trigger a single cycle (blocking JSON response) ───────────────────────────
  app.post("/cycle", async (_req: Request, res: Response): Promise<void> => {
    if (orchestrator.isRunning()) {
      res.status(409).json({ error: "A cycle is already running" });
      return;
    }
    try {
      orchestrator.setRunning(true);
      const state = await orchestrator.runCycle();
      res.json(state);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    } finally {
      orchestrator.setRunning(false);
    }
  });

  // ── Trigger a cycle with SSE streaming ───────────────────────────────────────
  app.post("/cycle/stream", async (_req: Request, res: Response): Promise<void> => {
    if (orchestrator.isRunning()) {
      res.status(409).json({ error: "A cycle is already running" });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const send = (event: SwarmEvent): void => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    try {
      orchestrator.setRunning(true);
      for await (const event of orchestrator.runCycleStream()) {
        send(event);
      }
    } finally {
      orchestrator.setRunning(false);
      res.write("data: [DONE]\n\n");
      res.end();
    }
  });

  // ── Blackboard memory dump (after a cycle) ─────────────────────────────────────
  app.get("/memory", (_req: Request, res: Response): void => {
    res.json(orchestrator.getMemory());
  });

  // ── Cycle history ─────────────────────────────────────────────────────────────
  app.get("/history", (_req: Request, res: Response): void => {
    res.json(orchestrator.getHistory());
  });

  // ── Latest cycle ──────────────────────────────────────────────────────────────
  app.get("/latest", (_req: Request, res: Response): void => {
    const latest = orchestrator.getLatest();
    if (!latest) {
      res.status(404).json({ error: "No cycles run yet" });
      return;
    }
    res.json(latest);
  });

  return app;
}

export async function startServer(orchestrator: SwarmOrchestrator): Promise<void> {
  const cfg = getConfig();
  const app = createServer(orchestrator);

  app.listen(cfg.PORT, "0.0.0.0", () => {
    logger.info(`[API] Uniswap Swarm listening on http://0.0.0.0:${cfg.PORT}`);
    logger.info(`[API]   POST /cycle          → run one full agent cycle (JSON)`);
    logger.info(`[API]   POST /cycle/stream   → same but SSE token stream`);
    logger.info(`[API]   GET  /history        → all past cycles`);
    logger.info(`[API]   GET  /latest         → most recent cycle`);
    logger.info(`[API]   GET  /health         → liveness check`);
    logger.info(
      `[API]   DRY_RUN=${cfg.DRY_RUN ? "true (no real trades)" : "⚠️  false — LIVE TRADING"}`
    );
  });
}
