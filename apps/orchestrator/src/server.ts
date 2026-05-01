import express, { type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { SwarmOrchestrator } from "./orchestrator";
import { getConfig, logger } from "@swarm/shared";
import type { SwarmCycleState, SwarmEvent } from "@swarm/shared";
import {
  registerA2ARoutes,
  selectAgentForIntent,
  type SwarmAgentName,
  type SwarmFlowStep,
  type SwarmTransfer,
} from "./a2aOrchestrator";
import {
  registerSwarmA2AAgentRoutes,
  type AgentExecutionHookParams,
} from "./a2aAgents";
import { ZERO_ADDRESS } from "@swarm/shared";
import { DynamoHistoryStore } from "./historyStore";

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

function resolveSessionId(req: Request, autoCreate = true): string {
  const cached = (req as Request & { __sessionId?: string }).__sessionId;
  if (cached) return cached;

  const bodySessionId =
    typeof (req.body as { sessionId?: unknown } | undefined)?.sessionId ===
    "string"
      ? ((req.body as { sessionId?: string }).sessionId ?? "").trim()
      : "";
  const headerSessionId = (req.header("x-session-id") ?? "").trim();
  const querySessionId =
    typeof req.query.sessionId === "string" ? req.query.sessionId.trim() : "";

  const resolved = bodySessionId || headerSessionId || querySessionId;
  if (resolved) {
    (req as Request & { __sessionId?: string }).__sessionId = resolved;
    return resolved;
  }

  if (!autoCreate) return "";

  const generated = randomUUID();
  (req as Request & { __sessionId?: string }).__sessionId = generated;
  return generated;
}

function resolveHistoryOwnerKey(req: Request): string {
  const bodyWallet =
    typeof (req.body as { walletAddress?: unknown } | undefined)
      ?.walletAddress === "string"
      ? ((req.body as { walletAddress?: string }).walletAddress ?? "").trim()
      : "";
  const headerWallet = (req.header("x-wallet-address") ?? "").trim();
  const queryWallet =
    typeof req.query.walletAddress === "string"
      ? req.query.walletAddress.trim()
      : "";

  // Backwards-compatible fallback to userId-based lookup.
  const bodyUserId =
    typeof (req.body as { userId?: unknown } | undefined)?.userId === "string"
      ? ((req.body as { userId?: string }).userId ?? "").trim()
      : "";
  const headerUserId = (req.header("x-user-id") ?? "").trim();
  const queryUserId =
    typeof req.query.userId === "string" ? req.query.userId.trim() : "";

  const resolved =
    bodyWallet ||
    headerWallet ||
    queryWallet ||
    bodyUserId ||
    headerUserId ||
    queryUserId ||
    "anonymous";
  const normalized = resolved.toLowerCase();
  return normalized === ZERO_ADDRESS ? "anonymous" : normalized;
}

function resolveSessionParam(req: Request, key: "sessionId"): string | null {
  const raw = req.params[key];
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return raw[0] ?? null;
  return null;
}

function toObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function buildCycleStateFromMemory(
  orchestrator: SwarmOrchestrator,
  sessionId: string,
  cycleId: string,
  startedAt: number,
): SwarmCycleState {
  const state: SwarmCycleState = {
    cycleId,
    startedAt,
    completedAt: Date.now(),
  };
  const memory = orchestrator.getMemory(sessionId);
  for (const entry of memory) {
    if (entry.key === "researcher/report") {
      if (entry.value !== undefined) {
        state.research = entry.value as NonNullable<
          SwarmCycleState["research"]
        >;
      }
    } else if (entry.key === "planner/plan") {
      if (entry.value !== undefined) {
        state.plan = entry.value as NonNullable<SwarmCycleState["plan"]>;
      }
    } else if (entry.key === "risk/assessments") {
      if (entry.value !== undefined) {
        state.riskAssessments = entry.value as NonNullable<
          SwarmCycleState["riskAssessments"]
        >;
      }
    } else if (entry.key === "strategy/proposal") {
      if (entry.value !== undefined) {
        state.strategy = entry.value as NonNullable<
          SwarmCycleState["strategy"]
        >;
      }
    } else if (entry.key === "critic/critique") {
      if (entry.value !== undefined) {
        state.critique = entry.value as NonNullable<
          SwarmCycleState["critique"]
        >;
      }
    } else if (entry.key === "executor/result") {
      if (entry.value !== undefined) {
        state.execution = entry.value as NonNullable<
          SwarmCycleState["execution"]
        >;
      }
    }
  }
  return state;
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createServer(
  orchestrator: SwarmOrchestrator,
): express.Application {
  const app = express();
  const cfg = getConfig();
  const dynamoRegion = cfg.DYNAMODB_REGION.trim();
  const dynamoTable = cfg.DYNAMODB_HISTORY_TABLE.trim();
  const dynamoGsiUser = cfg.DYNAMODB_HISTORY_GSI_USER.trim() || "GSI1";
  const awsAccessKeyId = cfg.AWS_ACCESS_KEY_ID.trim();
  const awsSecretAccessKey = cfg.AWS_SECRET_ACCESS_KEY.trim();
  const awsSessionToken = cfg.AWS_SESSION_TOKEN.trim();
  const credentials =
    awsAccessKeyId && awsSecretAccessKey
      ? {
          accessKeyId: awsAccessKeyId,
          secretAccessKey: awsSecretAccessKey,
          ...(awsSessionToken ? { sessionToken: awsSessionToken } : {}),
        }
      : undefined;
  const historyStore =
    dynamoRegion && dynamoTable
      ? new DynamoHistoryStore(
          dynamoRegion,
          dynamoTable,
          dynamoGsiUser,
          credentials,
        )
      : null;
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

  // Register individual A2A agent routes on the same port
  const agentRoutes = registerSwarmA2AAgentRoutes(
    app,
    orchestrator,
    publicBaseUrl,
    async (params: AgentExecutionHookParams): Promise<void> => {
      if (!historyStore) return;
      const shouldPersist =
        params.agentId === "executor" ||
        params.agentId === "critic" ||
        params.runError != null;
      if (!shouldPersist) return;

      const now = Date.now();
      const state = buildCycleStateFromMemory(
        orchestrator,
        params.sessionId,
        `a2a-agent-${params.sessionId}-${now}`,
        now,
      );

      if (params.agentId === "critic") {
        const critiqueObj = toObject(params.payload);
        const approved = critiqueObj?.approved;
        if (approved === false) {
          state.execution = {
            dryRun: cfg.DRY_RUN,
            txHash: null,
            success: false,
            amountIn: "0",
            amountOut: null,
            gasUsed: null,
            priceImpactPct: null,
            executedAt: Date.now(),
            error: "Rejected by critic; execution skipped",
          };
        }
      }

      if (params.runError) {
        state.execution = {
          dryRun: cfg.DRY_RUN,
          txHash: null,
          success: false,
          amountIn: "0",
          amountOut: null,
          gasUsed: null,
          priceImpactPct: null,
          executedAt: Date.now(),
          error: `A2A ${params.agentId} error: ${params.runError}`,
        };
      }

      await historyStore.recordCycle(
        params.walletAddress ?? "anonymous",
        params.sessionId,
        state,
      );
    },
  );

  // Store agent routes for logging
  (
    app as express.Application & { __agentRoutes?: typeof agentRoutes }
  ).__agentRoutes = agentRoutes;

  // ── Intent-routed A2A stream ───────────────────────────────────────────────
  // POST /a2a/route/stream body: { query: string }
  app.post(
    "/a2a/route/stream",
    async (req: Request, res: Response): Promise<void> => {
      const sessionId = resolveSessionId(req);
      const ownerKey = resolveHistoryOwnerKey(req);
      const { query, walletAddress } = req.body as {
        query?: string;
        walletAddress?: string;
      };
      const requestText =
        typeof query === "string" && query.trim().length > 0
          ? query.trim()
          : "Run researcher for current market state.";

      const selectedAgent = selectAgentForIntent(requestText);
      const cycleId = `a2a-stream-${Date.now()}`;
      const cycleStartedAt = Date.now();
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
      res.setHeader("X-Session-Id", sessionId);
      emit({
        type: "cycle_start",
        cycleId,
        agentId: "orchestrator",
        data: { selectedAgent, sessionId },
        ts: ts(),
      });

      try {
        let result: unknown;
        const onChunk =
          (agentId: string) =>
          (chunk: string): void => {
            emit({ type: "delta", cycleId, agentId, content: chunk, ts: ts() });
          };

        if (selectedAgent === "trade_pipeline") {
          emitAgentStart("researcher", "run_researcher_report");
          const research = await orchestrator.runResearcher(
            sessionId,
            requestText,
            onChunk("researcher"),
            walletAddress,
          );
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
          const plan = await orchestrator.runPlanner(
            sessionId,
            requestText,
            onChunk("planner"),
          );
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
          const riskAssessments = await orchestrator.runRisk(
            sessionId,
            onChunk("risk"),
          );
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
          const strategy = await orchestrator.runStrategy(
            sessionId,
            onChunk("strategy"),
            walletAddress,
          );
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
          const critique = await orchestrator.runCritic(
            sessionId,
            onChunk("critic"),
          );
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
          const execution = await orchestrator.runExecutor(sessionId);
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
          const market = await orchestrator.fetchMarketData(sessionId, tokens);
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
          const prices = await orchestrator.fetchPrices(sessionId, tokens);
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
            researcher: () =>
              orchestrator.runResearcher(
                sessionId,
                requestText,
                onChunk(selectedAgent),
              ),
            researcher_market: async () => null,
            researcher_prices: async () => null,
            planner: () =>
              orchestrator.runPlanner(
                sessionId,
                requestText,
                onChunk(selectedAgent),
              ),
            risk: () => orchestrator.runRisk(sessionId, onChunk(selectedAgent)),
            strategy: () =>
              orchestrator.runStrategy(sessionId, onChunk(selectedAgent)),
            critic: () =>
              orchestrator.runCritic(sessionId, onChunk(selectedAgent)),
            executor: () => orchestrator.runExecutor(sessionId),
            cycle: () => orchestrator.runCycle(sessionId),
            wallet_watch: async () => {
              const research = await orchestrator.runResearcher(
                sessionId,
                requestText,
                onChunk("researcher"),
              );
              addTransfer({
                from: "researcher",
                to: "planner",
                summary: "Research report handed to planner",
                payload: { candidates: research.candidates.length },
              });
              const plan = await orchestrator.runPlanner(
                sessionId,
                requestText,
                onChunk("planner"),
              );
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

        if (historyStore) {
          let stateToPersist: SwarmCycleState | null = null;
          if (selectedAgent === "trade_pipeline") {
            const tradeResult = result as {
              research?: SwarmCycleState["research"];
              plan?: SwarmCycleState["plan"];
              riskAssessments?: SwarmCycleState["riskAssessments"];
              strategy?: SwarmCycleState["strategy"];
              critique?: SwarmCycleState["critique"];
              execution?: SwarmCycleState["execution"];
            };
            const tradeState: SwarmCycleState = {
              cycleId,
              startedAt: cycleStartedAt,
              completedAt: Date.now(),
            };
            if (tradeResult.research)
              tradeState.research = tradeResult.research;
            if (tradeResult.plan) tradeState.plan = tradeResult.plan;
            if (tradeResult.riskAssessments) {
              tradeState.riskAssessments = tradeResult.riskAssessments;
            }
            if (tradeResult.strategy)
              tradeState.strategy = tradeResult.strategy;
            if (tradeResult.critique)
              tradeState.critique = tradeResult.critique;
            if (tradeResult.execution) {
              tradeState.execution = tradeResult.execution;
            }
            stateToPersist = tradeState;
          } else if (selectedAgent === "cycle") {
            stateToPersist = result as SwarmCycleState;
          }
          if (stateToPersist) {
            await historyStore.recordCycle(ownerKey, sessionId, stateToPersist);
          }
        }

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

  // ── Per-agent helpers ───────────────────────────────────────────────────────
  // Each pair: POST /agents/<name>  (JSON) + POST /agents/<name>/stream (SSE)

  type AgentRunner = () => Promise<unknown>;

  function agentJson(
    agentId: string,
    runFn: (req: Request, sessionId: string) => AgentRunner,
  ): express.RequestHandler {
    return async (req: Request, res: Response): Promise<void> => {
      const sessionId = resolveSessionId(req);
      try {
        res.setHeader("X-Session-Id", sessionId);
        const data = await runFn(req, sessionId)();
        res.json({ sessionId, agentId, data });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(500).json({ sessionId, agentId, error: msg });
      }
    };
  }

  function agentStream(
    agentId: string,
    runFn: (req: Request, sessionId: string) => AgentRunner,
  ): express.RequestHandler {
    return async (req: Request, res: Response): Promise<void> => {
      const sessionId = resolveSessionId(req);
      sseHeaders(res);
      res.setHeader("X-Session-Id", sessionId);
      try {
        for await (const event of orchestrator.runAgentStream(
          sessionId,
          agentId,
          runFn(req, sessionId),
        )) {
          sseSend(res, event);
        }
      } finally {
        sseDone(res);
      }
    };
  }

  // ── Researcher ──────────────────────────────────────────────────────────────
  // POST /agents/researcher          body: { goal?: string, walletAddress?: string }
  // POST /agents/researcher/stream   body: { goal?: string, walletAddress?: string }
  app.post(
    "/agents/researcher",
    agentJson("researcher", (req, sessionId) => {
      const { goal, walletAddress } = req.body as {
        goal?: string;
        walletAddress?: string;
      };
      return () =>
        orchestrator.runResearcher(sessionId, goal, undefined, walletAddress);
    }),
  );
  app.post(
    "/agents/researcher/stream",
    agentStream("researcher", (req, sessionId) => {
      const { goal, walletAddress } = req.body as {
        goal?: string;
        walletAddress?: string;
      };
      return () =>
        orchestrator.runResearcher(sessionId, goal, undefined, walletAddress);
    }),
  );

  // ── Researcher: token prices ────────────────────────────────────────────────
  // POST /agents/researcher/prices          body: { tokens: string[] }
  // POST /agents/researcher/prices/stream   body: { tokens: string[] }
  app.post(
    "/agents/researcher/prices",
    async (req: Request, res: Response): Promise<void> => {
      const sessionId = resolveSessionId(req);
      const { tokens } = req.body as { tokens?: string[] };
      if (!Array.isArray(tokens) || tokens.length === 0) {
        res
          .status(400)
          .json({ error: "Body must contain a non-empty 'tokens' array" });
        return;
      }
      try {
        res.setHeader("X-Session-Id", sessionId);
        const data = await orchestrator.fetchPrices(sessionId, tokens);
        res.json({ sessionId, ...data });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: msg });
      }
    },
  );
  app.post(
    "/agents/researcher/prices/stream",
    async (req: Request, res: Response): Promise<void> => {
      const sessionId = resolveSessionId(req);
      const { tokens } = req.body as { tokens?: string[] };
      if (!Array.isArray(tokens) || tokens.length === 0) {
        res
          .status(400)
          .json({ error: "Body must contain a non-empty 'tokens' array" });
        return;
      }
      sseHeaders(res);
      res.setHeader("X-Session-Id", sessionId);
      try {
        for await (const event of orchestrator.runAgentStream(
          sessionId,
          "researcher",
          () => orchestrator.fetchPrices(sessionId, tokens),
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
      const sessionId = resolveSessionId(req);
      const { tokens } = req.body as { tokens?: string[] };
      if (!Array.isArray(tokens) || tokens.length === 0) {
        res
          .status(400)
          .json({ error: "Body must contain a non-empty 'tokens' array" });
        return;
      }
      try {
        res.setHeader("X-Session-Id", sessionId);
        const data = await orchestrator.fetchMarketData(sessionId, tokens);
        res.json({ sessionId, data });
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
    agentJson("planner", (req, sessionId) => {
      const goal = (req.body as { goal?: string }).goal;
      return () => orchestrator.runPlanner(sessionId, goal);
    }),
  );
  app.post(
    "/agents/planner/stream",
    agentStream("planner", (req, sessionId) => {
      const goal = (req.body as { goal?: string }).goal;
      return () => orchestrator.runPlanner(sessionId, goal);
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
      const sessionId = resolveSessionId(req);
      const ts = () => Date.now();

      try {
        res.setHeader("X-Session-Id", sessionId);
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
        const research = await orchestrator.runResearcher(sessionId, goal);
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
        const plan = await orchestrator.runPlanner(sessionId, goal);
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
    agentJson("risk", (_req, sessionId) => {
      return () => orchestrator.runRisk(sessionId);
    }),
  );
  app.post(
    "/agents/risk/stream",
    agentStream("risk", (_req, sessionId) => {
      return () => orchestrator.runRisk(sessionId);
    }),
  );

  // ── Strategy ────────────────────────────────────────────────────────────────
  // POST /agents/strategy          body: { walletAddress?: string }
  // POST /agents/strategy/stream   body: { walletAddress?: string }
  app.post(
    "/agents/strategy",
    agentJson("strategy", (req, sessionId) => {
      const { walletAddress } = (req.body ?? {}) as { walletAddress?: string };
      return () =>
        orchestrator.runStrategy(sessionId, undefined, walletAddress);
    }),
  );
  app.post(
    "/agents/strategy/stream",
    agentStream("strategy", (req, sessionId) => {
      const { walletAddress } = (req.body ?? {}) as { walletAddress?: string };
      return () =>
        orchestrator.runStrategy(sessionId, undefined, walletAddress);
    }),
  );

  // ── Critic ──────────────────────────────────────────────────────────────────
  // POST /agents/critic          (no body required — reads memory)
  // POST /agents/critic/stream
  app.post(
    "/agents/critic",
    agentJson("critic", (_req, sessionId) => {
      return () => orchestrator.runCritic(sessionId);
    }),
  );
  app.post(
    "/agents/critic/stream",
    agentStream("critic", (_req, sessionId) => {
      return () => orchestrator.runCritic(sessionId);
    }),
  );

  // ── Executor ────────────────────────────────────────────────────────────────
  // POST /agents/executor          (no body required — reads memory)
  // POST /agents/executor/stream
  app.post(
    "/agents/executor",
    agentJson("executor", (_req, sessionId) => {
      return () => orchestrator.runExecutor(sessionId);
    }),
  );
  app.post(
    "/agents/executor/stream",
    agentStream("executor", (_req, sessionId) => {
      return () => orchestrator.runExecutor(sessionId);
    }),
  );

  // ── Blackboard memory dump ─────────────────────────────────────────────────
  // GET /memory - returns memory for specific session if sessionId provided, otherwise all memory
  app.get("/memory", (req: Request, res: Response): void => {
    const sessionId = resolveSessionId(req, false);
    res.setHeader("X-Session-Id", sessionId || "none");
    if (sessionId) {
      res.json({ sessionId, data: orchestrator.getMemory(sessionId) });
      return;
    }

    res.json({ data: orchestrator.getMemory() });
  });

  // ── Cycle history ──────────────────────────────────────────────────────────
  // GET /history - returns history for specific session if sessionId provided
  app.get("/history", (req: Request, res: Response): void => {
    const sessionId = resolveSessionId(req, false);
    res.setHeader("X-Session-Id", sessionId || "none");
    if (!historyStore) {
      res.json(orchestrator.getHistory());
      return;
    }
    if (!sessionId) {
      res.json([]);
      return;
    }
    void historyStore
      .listCycles(sessionId, 100)
      .then((rows) => res.json(rows.map((row) => row.state)))
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: msg });
      });
  });

  app.get("/history/sessions", (req: Request, res: Response): void => {
    if (!historyStore) {
      res.json({ data: [] });
      return;
    }
    const ownerKey = resolveHistoryOwnerKey(req);
    const limitRaw =
      typeof req.query.limit === "string" ? Number(req.query.limit) : 20;
    const limit = Number.isFinite(limitRaw) ? limitRaw : 20;
    void historyStore
      .listSessionsByUser(ownerKey, limit)
      .then((data) => res.json({ data }))
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: msg });
      });
  });

  app.get(
    "/history/sessions/:sessionId",
    (req: Request, res: Response): void => {
      if (!historyStore) {
        res.status(404).json({ error: "History store is not configured" });
        return;
      }
      const sessionId = resolveSessionParam(req, "sessionId");
      if (!sessionId) {
        res.status(400).json({ error: "sessionId is required" });
        return;
      }
      void historyStore
        .getSession(sessionId)
        .then((data) => {
          if (!data) {
            res.status(404).json({ error: "Session not found" });
            return;
          }
          res.json(data);
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          res.status(500).json({ error: msg });
        });
    },
  );

  app.get(
    "/history/sessions/:sessionId/cycles",
    (req: Request, res: Response): void => {
      if (!historyStore) {
        res.json({ data: [] });
        return;
      }
      const sessionId = resolveSessionParam(req, "sessionId");
      if (!sessionId) {
        res.status(400).json({ error: "sessionId is required" });
        return;
      }
      const limitRaw =
        typeof req.query.limit === "string" ? Number(req.query.limit) : 50;
      const limit = Number.isFinite(limitRaw) ? limitRaw : 50;
      void historyStore
        .listCycles(sessionId, limit)
        .then((data) => res.json({ data }))
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          res.status(500).json({ error: msg });
        });
    },
  );

  // ── Latest cycle ───────────────────────────────────────────────────────────
  // GET /latest - returns latest cycle for specific session if sessionId provided
  app.get("/latest", (req: Request, res: Response): void => {
    const sessionId = resolveSessionId(req, false);
    res.setHeader("X-Session-Id", sessionId || "none");
    const latest = orchestrator.getLatest();
    if (!latest) {
      res.status(404).json({ error: "No cycles run yet" });
      return;
    }
    res.json(latest);
  });

  // ── Managed wallet ledger balance ──────────────────────────────────────────
  // GET /managed-wallet/:connectedAddress/ledger
  // Decrypts the user's managed key, opens a broker, and returns the 0G Compute
  // ledger balance for that wallet. Called server-to-server by the web API.
  app.get(
    "/managed-wallet/:connectedAddress/ledger",
    async (req: Request, res: Response): Promise<void> => {
      const { connectedAddress } = req.params as { connectedAddress: string };
      if (!/^0x[0-9a-fA-F]{40}$/.test(connectedAddress)) {
        res.status(400).json({ error: "Invalid address" });
        return;
      }
      try {
        const { getManagedPrivateKey } = await import("./managedWallets");
        const { ZGCompute } = await import("@swarm/compute");
        const privateKey = await getManagedPrivateKey(connectedAddress);
        if (!privateKey) {
          res.json({ ledgerBalance: null, ledgerLow: null });
          return;
        }
        const compute = new ZGCompute(privateKey);
        // init() creates the broker; we need it to query the ledger
        await compute.init().catch(() => {
          /* LedgerLowError is fine here — we still get the balance below */
        });
        const ledgerBalance = await compute.getLedgerBalance();
        res.json({ ledgerBalance, ledgerLow: ledgerBalance < 3 });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: msg });
      }
    },
  );

  // ── Fund managed wallet ledger ─────────────────────────────────────────────
  // POST /managed-wallet/:connectedAddress/fund-ledger
  // Body: { amount: number }  (OG tokens, e.g. 5)
  // Deposits the requested amount from the managed wallet into the 0G Compute
  // ledger (or creates a new ledger if none exists).
  app.post(
    "/managed-wallet/:connectedAddress/fund-ledger",
    async (req: Request, res: Response): Promise<void> => {
      const { connectedAddress } = req.params as { connectedAddress: string };
      if (!/^0x[0-9a-fA-F]{40}$/.test(connectedAddress)) {
        res.status(400).json({ error: "Invalid address" });
        return;
      }
      const body = req.body as { amount?: unknown };
      const amount = Number(body.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        res.status(400).json({ error: "amount must be a positive number (OG)" });
        return;
      }
      try {
        const { getManagedPrivateKey } = await import("./managedWallets");
        const { ZGCompute } = await import("@swarm/compute");
        const privateKey = await getManagedPrivateKey(connectedAddress);
        if (!privateKey) {
          res.status(404).json({ error: "No managed wallet found for this address" });
          return;
        }
        const compute = new ZGCompute(privateKey);
        await compute.fundLedger(amount);
        const ledgerBalance = await compute.getLedgerBalance();
        res.json({ ok: true, ledgerBalance, ledgerLow: ledgerBalance < 3 });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: msg });
      }
    },
  );

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
      `[API]   POST /a2a/route/stream                   → intent-routed pipeline (SSE)`,
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
      `[API]   GET  /history/sessions   GET /history/sessions/:sessionId   GET /history/sessions/:sessionId/cycles`,
    );
    logger.info(
      `[API]   DRY_RUN=${cfg.DRY_RUN ? "true (no real trades)" : "⚠️  false — LIVE TRADING"}`,
    );
    logger.info(`[API] A2A Orchestrator:`);
    logger.info(`[API]   GET  /.well-known/agent-card.json`);
    logger.info(`[API]   POST /a2a/jsonrpc   POST /a2a/rest`);

    const agentRoutes = (
      app as express.Application & { __agentRoutes?: unknown }
    ).__agentRoutes as
      | Array<{ route: string; agent: { cardName: string } }>
      | undefined;
    if (agentRoutes && agentRoutes.length > 0) {
      logger.info(`[API] A2A Individual Agents (same port):`);
      for (const { route, agent } of agentRoutes) {
        logger.info(`[API]   ${route.padEnd(30)} → ${agent.cardName}`);
      }
    }
  });
}
