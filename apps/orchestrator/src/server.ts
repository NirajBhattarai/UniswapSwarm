import express, { type Request, type Response } from "express";
import { SwarmOrchestrator } from "./orchestrator";
import { getConfig, logger } from "@swarm/shared";
import type { SwarmEvent } from "@swarm/shared";
import {
  registerA2ARoutes,
  selectAgentForIntent,
  type SwarmAgentName,
  type SwarmFlowStep,
  type SwarmTransfer,
} from "./a2aOrchestrator";

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

function extractTokensFromQuery(text: string): string[] {
  const matches = text.match(/\b[A-Za-z]{2,10}\b/g) ?? [];
  const stopWords = new Set([
    "THE",
    "AND",
    "FOR",
    "WITH",
    "FROM",
    "WHAT",
    "WHEN",
    "WHERE",
    "SHOW",
    "PRICE",
    "PRICES",
    "MARKET",
    "DATA",
    "TOKEN",
    "TOKENS",
    "QUOTE",
    "QUOTES",
    "SWAP",
    "PLAN",
    "RISK",
    "RESEARCH",
  ]);

  const symbols = matches
    .map((token) => token.toUpperCase())
    .filter((token) => token.length >= 2 && token.length <= 6)
    .filter((token) => !stopWords.has(token));

  const deduped = Array.from(new Set(symbols));
  return deduped.length > 0 ? deduped.slice(0, 12) : ["ETH", "UNI", "ARB"];
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createServer(
  orchestrator: SwarmOrchestrator,
): express.Application {
  const app = express();
  const cfg = getConfig();
  const publicBaseUrl =
    process.env.A2A_PUBLIC_BASE_URL ?? `http://localhost:${cfg.PORT}`;
  app.use(express.json());

  // Basic CORS for web UI (localhost:3000/3001) calling orchestrator endpoints.
  app.use((req: Request, res: Response, next): void => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization",
    );
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  registerA2ARoutes(app, orchestrator, publicBaseUrl);

  // ── Intent-routed A2A stream ───────────────────────────────────────────────
  // POST /a2a/route/stream body: { query: string }
  app.post(
    "/a2a/route/stream",
    async (req: Request, res: Response): Promise<void> => {
      const { query } = req.body as { query?: string };
      const requestText =
        typeof query === "string" && query.trim().length > 0
          ? query.trim()
          : "Run researcher for current market state.";

      const selectedAgent = selectAgentForIntent(requestText);
      const cycleId = `a2a-stream-${Date.now()}`;
      const ts = () => Date.now();

      const flow: SwarmFlowStep[] = [
        {
          from: "user",
          to: "orchestrator",
          action: "submit_request",
          status: "completed",
          detail: requestText,
        },
        {
          from: "orchestrator",
          to: selectedAgent,
          action: "route_by_intent",
          status: "selected",
        },
      ];
      const transfers: SwarmTransfer[] = [];

      const emit = (event: SwarmEvent): void => {
        sseSend(res, event);
      };

      const emitAgentStart = (agentId: string, action: string): void => {
        flow.push({
          from: "orchestrator",
          to: agentId,
          action,
          status: "running",
        });
        emit({ type: "agent_start", cycleId, agentId, ts: ts() });
      };

      const emitAgentDone = (
        agentId: string,
        action: string,
        data?: unknown,
        detail?: string,
      ): void => {
        flow.push({
          from: "orchestrator",
          to: agentId,
          action,
          status: "completed",
          ...(detail ? { detail } : {}),
        });
        emit({ type: "agent_done", cycleId, agentId, data, ts: ts() });
      };

      const addTransfer = (transfer: SwarmTransfer): void => {
        transfers.push(transfer);
        emit({
          type: "agent_done",
          cycleId,
          agentId: "orchestrator",
          data: { transfer },
          ts: ts(),
        });
      };

      sseHeaders(res);
      emit({
        type: "cycle_start",
        cycleId,
        agentId: "orchestrator",
        data: { selectedAgent },
        ts: ts(),
      });

      try {
        let result: unknown;

        if (selectedAgent === "trade_pipeline") {
          emitAgentStart("researcher", "run_researcher_report");
          const research = await orchestrator.runResearcher(requestText);
          emitAgentDone(
            "researcher",
            "run_researcher_report",
            { candidates: research.candidates.length },
            `candidates=${research.candidates.length}`,
          );
          addTransfer({
            from: "researcher",
            to: "planner",
            summary: "Research candidates and market summary sent to planner",
            payload: {
              candidates: research.candidates.length,
              dataSource: research.dataSource,
            },
          });

          emitAgentStart("planner", "run_plan");
          const plan = await orchestrator.runPlanner(requestText);
          emitAgentDone(
            "planner",
            "run_plan",
            { strategy: plan.strategy },
            `strategy=${plan.strategy}`,
          );
          addTransfer({
            from: "planner",
            to: "risk",
            summary: "Plan constraints and task graph sent to risk",
            payload: {
              strategy: plan.strategy,
              taskCount: plan.tasks.length,
            },
          });

          emitAgentStart("risk", "run_risk");
          const riskAssessments = await orchestrator.runRisk();
          const passedCount = riskAssessments.filter(
            (item) => item.passed,
          ).length;
          emitAgentDone(
            "risk",
            "run_risk",
            { total: riskAssessments.length, passed: passedCount },
            `passed=${passedCount}/${riskAssessments.length}`,
          );
          addTransfer({
            from: "risk",
            to: "strategy",
            summary: "Risk assessments sent to strategy",
            payload: {
              total: riskAssessments.length,
              passed: passedCount,
            },
          });

          emitAgentStart("strategy", "run_strategy");
          const strategy = await orchestrator.runStrategy();
          emitAgentDone(
            "strategy",
            "run_strategy",
            strategy,
            strategy
              ? `${strategy.tokenInSymbol}->${strategy.tokenOutSymbol}`
              : "no-strategy",
          );
          addTransfer({
            from: "strategy",
            to: "critic",
            summary: "Proposed strategy sent to critic for approval",
            payload: strategy
              ? {
                  pair: `${strategy.tokenInSymbol}->${strategy.tokenOutSymbol}`,
                  slippagePct: strategy.slippagePct,
                }
              : { pair: "none" },
          });

          emitAgentStart("critic", "run_critic");
          const critique = await orchestrator.runCritic();
          emitAgentDone(
            "critic",
            "run_critic",
            critique,
            critique.approved ? "approved" : "rejected",
          );
          addTransfer({
            from: "critic",
            to: "executor",
            summary: "Approval decision sent to executor",
            payload: {
              approved: critique.approved,
              confidence: critique.confidence,
            },
          });

          emitAgentStart("executor", "run_executor");
          const execution = await orchestrator.runExecutor();
          emitAgentDone(
            "executor",
            "run_executor",
            execution,
            execution.success ? "success" : "failed",
          );
          addTransfer({
            from: "executor",
            to: "chat",
            summary: "Execution result returned to user",
            payload: {
              success: execution.success,
              dryRun: execution.dryRun,
              txHash: execution.txHash,
            },
          });

          result = {
            pipeline: [
              "researcher",
              "planner",
              "risk",
              "strategy",
              "critic",
              "executor",
            ],
            research,
            plan,
            riskAssessments,
            strategy,
            critique,
            execution,
          };
        } else if (selectedAgent === "researcher_market") {
          const tokens = extractTokensFromQuery(requestText);
          emitAgentStart("researcher_market", "fetch_market_data");
          const market = await orchestrator.fetchMarketData(tokens);
          emitAgentDone(
            "researcher_market",
            "fetch_market_data",
            market,
            `tokens=${tokens.join(",")}`,
          );
          addTransfer({
            from: "orchestrator",
            to: "chat",
            summary: "Market data transfer ready",
            payload: { tokens },
          });
          result = market;
        } else if (selectedAgent === "researcher_prices") {
          const tokens = extractTokensFromQuery(requestText);
          emitAgentStart("researcher_prices", "fetch_token_prices");
          const prices = await orchestrator.fetchPrices(tokens);
          emitAgentDone(
            "researcher_prices",
            "fetch_token_prices",
            prices,
            `tokens=${tokens.join(",")}`,
          );
          addTransfer({
            from: "orchestrator",
            to: "chat",
            summary: "Token price transfer ready",
            payload: { tokens },
          });
          result = prices;
        } else {
          const runMap: Record<SwarmAgentName, () => Promise<unknown>> = {
            trade_pipeline: async () => null,
            researcher: () => orchestrator.runResearcher(requestText),
            researcher_market: async () => null,
            researcher_prices: async () => null,
            planner: () => orchestrator.runPlanner(requestText),
            risk: () => orchestrator.runRisk(),
            strategy: () => orchestrator.runStrategy(),
            critic: () => orchestrator.runCritic(),
            executor: () => orchestrator.runExecutor(),
            cycle: () => orchestrator.runCycle(),
            wallet_watch: async () => {
              const research = await orchestrator.runResearcher(requestText);
              addTransfer({
                from: "researcher",
                to: "planner",
                summary: "Research report handed to planner",
                payload: { candidates: research.candidates.length },
              });
              const plan = await orchestrator.runPlanner(requestText);
              return { research, plan, readyToSign: true };
            },
          };

          emitAgentStart(selectedAgent, `run_${selectedAgent}`);
          result = await runMap[selectedAgent]();
          emitAgentDone(selectedAgent, `run_${selectedAgent}`, result);
        }

        const payload = {
          orchestrator: "google-a2a-style-gateway",
          request: requestText,
          selectedAgent,
          flow,
          transfers,
          result,
        };

        emit({
          type: "cycle_done",
          cycleId,
          agentId: "orchestrator",
          data: payload,
          ts: ts(),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        emit({
          type: "cycle_error",
          cycleId,
          agentId: "orchestrator",
          content: msg,
          ts: ts(),
        });
      } finally {
        sseDone(res);
      }
    },
  );

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

  // ── Researcher: market data (CoinGecko) ────────────────────────────────────
  // POST /agents/researcher/market   body: { tokens: string[] }
  app.post(
    "/agents/researcher/market",
    async (req: Request, res: Response): Promise<void> => {
      const { tokens } = req.body as { tokens?: string[] };
      if (!Array.isArray(tokens) || tokens.length === 0) {
        res
          .status(400)
          .json({ error: "Body must contain a non-empty 'tokens' array" });
        return;
      }
      try {
        const data = await orchestrator.fetchMarketData(tokens);
        res.json(data);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: msg });
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

  // ── Wallet watch composite stream ────────────────────────────────────────────
  // POST /wallet-watch/stream body: { walletAddress: string, prompt?: string }
  app.post(
    "/wallet-watch/stream",
    async (req: Request, res: Response): Promise<void> => {
      const { walletAddress, prompt } = req.body as {
        walletAddress?: string;
        prompt?: string;
      };

      if (!walletAddress || typeof walletAddress !== "string") {
        res
          .status(400)
          .json({ error: "Body must contain a valid 'walletAddress' string" });
        return;
      }

      sseHeaders(res);
      const baseGoal =
        typeof prompt === "string" && prompt.trim().length > 0
          ? prompt.trim()
          : "Watch my wallet, map available funds, summarize market/news, then produce an actionable swap plan.";
      const goal = `${baseGoal}\nTarget wallet: ${walletAddress}`;
      const cycleId = `wallet-watch-${Date.now()}`;
      const ts = () => Date.now();

      try {
        sseSend(res, {
          type: "cycle_start",
          cycleId,
          agentId: "orchestrator",
          ts: ts(),
        });

        sseSend(res, {
          type: "agent_start",
          cycleId,
          agentId: "researcher",
          ts: ts(),
        });
        const research = await orchestrator.runResearcher(goal);
        sseSend(res, {
          type: "agent_done",
          cycleId,
          agentId: "researcher",
          data: research,
          ts: ts(),
        });

        sseSend(res, {
          type: "agent_start",
          cycleId,
          agentId: "planner",
          ts: ts(),
        });
        const plan = await orchestrator.runPlanner(goal);
        sseSend(res, {
          type: "agent_done",
          cycleId,
          agentId: "planner",
          data: plan,
          ts: ts(),
        });

        sseSend(res, {
          type: "cycle_done",
          cycleId,
          agentId: "orchestrator",
          data: { walletAddress, readyToSign: true },
          ts: ts(),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        sseSend(res, {
          type: "cycle_error",
          cycleId,
          agentId: "orchestrator",
          content: msg,
          ts: ts(),
        });
      } finally {
        sseDone(res);
      }
    },
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
      `[API]   POST /agents/researcher/market                                        body: { tokens[] }`,
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
    logger.info(`[API] A2A:`);
    logger.info(`[API]   GET  /.well-known/agent-card.json`);
    logger.info(`[API]   POST /a2a/jsonrpc   POST /a2a/rest`);
  });
}
