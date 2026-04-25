import express, { type Request, type Response } from "express";
import { SwarmOrchestrator } from "./orchestrator";
import { getConfig, logger } from "@swarm/shared";
import type { SwarmEvent } from "@swarm/shared";

// ── SSE helpers ────────────────────────────────────────────────────────────────

function sseHeaders(res: Response): void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
}

function sseSend(res: Response, event: SwarmEvent): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function sseDone(res: Response): void {
  res.write("data: [DONE]\n\n");
  res.end();
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createServer(
  orchestrator: SwarmOrchestrator,
): express.Application {
  const app = express();
  app.use(express.json());

  // ── Health ──────────────────────────────────────────────────────────────────
  app.get("/health", (_req: Request, res: Response): void => {
    res.json({ status: "ok", running: orchestrator.isRunning() });
  });

  // ── Full pipeline — blocking JSON ───────────────────────────────────────────
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

  // ── Full pipeline — SSE stream ──────────────────────────────────────────────
  app.post(
    "/cycle/stream",
    async (_req: Request, res: Response): Promise<void> => {
      if (orchestrator.isRunning()) {
        res.status(409).json({ error: "A cycle is already running" });
        return;
      }
      sseHeaders(res);
      try {
        orchestrator.setRunning(true);
        for await (const event of orchestrator.runCycleStream()) {
          sseSend(res, event);
        }
      } finally {
        orchestrator.setRunning(false);
        sseDone(res);
      }
    },
  );

  // ── Per-agent helpers ───────────────────────────────────────────────────────
  // Each pair: POST /agents/<name>  (JSON) + POST /agents/<name>/stream (SSE)

  type AgentRunner = () => Promise<unknown>;

  function agentJson(
    agentId: string,
    runFn: (req: Request) => AgentRunner,
  ): express.RequestHandler {
    return async (req: Request, res: Response): Promise<void> => {
      try {
        const data = await runFn(req)();
        res.json({ agentId, data });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(500).json({ agentId, error: msg });
      }
    };
  }

  function agentStream(
    agentId: string,
    runFn: (req: Request) => AgentRunner,
  ): express.RequestHandler {
    return async (req: Request, res: Response): Promise<void> => {
      sseHeaders(res);
      try {
        for await (const event of orchestrator.runAgentStream(
          agentId,
          runFn(req),
        )) {
          sseSend(res, event);
        }
      } finally {
        sseDone(res);
      }
    };
  }

  // ── Researcher ──────────────────────────────────────────────────────────────
  // POST /agents/researcher          body: { goal?: string }
  // POST /agents/researcher/stream   body: { goal?: string }
  app.post(
    "/agents/researcher",
    agentJson("researcher", (req) => {
      const goal = (req.body as { goal?: string }).goal;
      return () => orchestrator.runResearcher(goal);
    }),
  );
  app.post(
    "/agents/researcher/stream",
    agentStream("researcher", (req) => {
      const goal = (req.body as { goal?: string }).goal;
      return () => orchestrator.runResearcher(goal);
    }),
  );

  // ── Researcher: token prices ────────────────────────────────────────────────
  // POST /agents/researcher/prices          body: { tokens: string[] }
  // POST /agents/researcher/prices/stream   body: { tokens: string[] }
  app.post(
    "/agents/researcher/prices",
    async (req: Request, res: Response): Promise<void> => {
      const { tokens } = req.body as { tokens?: string[] };
      if (!Array.isArray(tokens) || tokens.length === 0) {
        res
          .status(400)
          .json({ error: "Body must contain a non-empty 'tokens' array" });
        return;
      }
      try {
        const data = await orchestrator.fetchPrices(tokens);
        res.json(data);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: msg });
      }
    },
  );
  app.post(
    "/agents/researcher/prices/stream",
    async (req: Request, res: Response): Promise<void> => {
      const { tokens } = req.body as { tokens?: string[] };
      if (!Array.isArray(tokens) || tokens.length === 0) {
        res
          .status(400)
          .json({ error: "Body must contain a non-empty 'tokens' array" });
        return;
      }
      sseHeaders(res);
      try {
        for await (const event of orchestrator.runAgentStream(
          "researcher",
          () => orchestrator.fetchPrices(tokens),
        )) {
          sseSend(res, event);
        }
      } finally {
        sseDone(res);
      }
    },
  );

  // ── Planner ─────────────────────────────────────────────────────────────────
  // POST /agents/planner          body: { goal?: string }
  // POST /agents/planner/stream   body: { goal?: string }
  app.post(
    "/agents/planner",
    agentJson("planner", (req) => {
      const goal = (req.body as { goal?: string }).goal;
      return () => orchestrator.runPlanner(goal);
    }),
  );
  app.post(
    "/agents/planner/stream",
    agentStream("planner", (req) => {
      const goal = (req.body as { goal?: string }).goal;
      return () => orchestrator.runPlanner(goal);
    }),
  );

  // ── Risk ────────────────────────────────────────────────────────────────────
  // POST /agents/risk          (no body required — reads memory)
  // POST /agents/risk/stream
  app.post(
    "/agents/risk",
    agentJson("risk", () => () => orchestrator.runRisk()),
  );
  app.post(
    "/agents/risk/stream",
    agentStream("risk", () => () => orchestrator.runRisk()),
  );

  // ── Strategy ────────────────────────────────────────────────────────────────
  // POST /agents/strategy          (no body required — reads memory)
  // POST /agents/strategy/stream
  app.post(
    "/agents/strategy",
    agentJson("strategy", () => () => orchestrator.runStrategy()),
  );
  app.post(
    "/agents/strategy/stream",
    agentStream("strategy", () => () => orchestrator.runStrategy()),
  );

  // ── Critic ──────────────────────────────────────────────────────────────────
  // POST /agents/critic          (no body required — reads memory)
  // POST /agents/critic/stream
  app.post(
    "/agents/critic",
    agentJson("critic", () => () => orchestrator.runCritic()),
  );
  app.post(
    "/agents/critic/stream",
    agentStream("critic", () => () => orchestrator.runCritic()),
  );

  // ── Executor ────────────────────────────────────────────────────────────────
  // POST /agents/executor          (no body required — reads memory)
  // POST /agents/executor/stream
  app.post(
    "/agents/executor",
    agentJson("executor", () => () => orchestrator.runExecutor()),
  );
  app.post(
    "/agents/executor/stream",
    agentStream("executor", () => () => orchestrator.runExecutor()),
  );

  // ── Blackboard memory dump ─────────────────────────────────────────────────
  app.get("/memory", (_req: Request, res: Response): void => {
    res.json(orchestrator.getMemory());
  });

  // ── Cycle history ──────────────────────────────────────────────────────────
  app.get("/history", (_req: Request, res: Response): void => {
    res.json(orchestrator.getHistory());
  });

  // ── Latest cycle ───────────────────────────────────────────────────────────
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

export async function startServer(
  orchestrator: SwarmOrchestrator,
): Promise<void> {
  const cfg = getConfig();
  const app = createServer(orchestrator);

  app.listen(cfg.PORT, "0.0.0.0", () => {
    logger.info(`[API] Uniswap Swarm listening on http://0.0.0.0:${cfg.PORT}`);
    logger.info(`[API] Full pipeline:`);
    logger.info(
      `[API]   POST /cycle                              → full pipeline (JSON)`,
    );
    logger.info(
      `[API]   POST /cycle/stream                       → full pipeline (SSE)`,
    );
    logger.info(`[API] Per-agent (JSON | SSE stream):`);
    logger.info(
      `[API]   POST /agents/researcher          | /agents/researcher/stream`,
    );
    logger.info(
      `[API]   POST /agents/researcher/prices   | /agents/researcher/prices/stream  body: { tokens[] }`,
    );
    logger.info(
      `[API]   POST /agents/planner             | /agents/planner/stream`,
    );
    logger.info(
      `[API]   POST /agents/risk                | /agents/risk/stream`,
    );
    logger.info(
      `[API]   POST /agents/strategy            | /agents/strategy/stream`,
    );
    logger.info(
      `[API]   POST /agents/critic              | /agents/critic/stream`,
    );
    logger.info(
      `[API]   POST /agents/executor            | /agents/executor/stream`,
    );
    logger.info(`[API] State:`);
    logger.info(
      `[API]   GET  /memory   GET /history   GET /latest   GET /health`,
    );
    logger.info(
      `[API]   DRY_RUN=${cfg.DRY_RUN ? "true (no real trades)" : "⚠️  false — LIVE TRADING"}`,
    );
  });
}
