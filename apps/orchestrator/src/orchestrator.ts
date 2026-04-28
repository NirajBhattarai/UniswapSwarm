import { v4 as uuidv4 } from "uuid";
import { ZGCompute } from "@swarm/compute";
import { BlackboardMemory, ZGStorage } from "@swarm/memory";
import type { InferOptions } from "@swarm/compute";
import { PlannerAgent } from "@swarm/agent-planner";
import { ResearchAgent } from "@swarm/agent-researcher";
import type {
  PriceQuoteResponse,
  CoinGeckoMarketData,
} from "@swarm/agent-researcher";
import { RiskAgent } from "@swarm/agent-risk";
import { StrategyAgent } from "@swarm/agent-strategy";
import { CriticAgent } from "@swarm/agent-critic";
import { ExecutorAgent } from "@swarm/agent-executor";
import { logger } from "@swarm/shared";
import type {
  SwarmCycleState,
  SwarmEvent,
  MemoryEntry,
  ResearchReport,
  TradePlan,
  RiskAssessment,
  TradeStrategy,
  Critique,
  ExecutionResult,
} from "@swarm/shared";

const GOAL =
  "Identify and execute profitable, low-risk token swaps on Uniswap (Ethereum mainnet). Prioritise capital preservation over profit.";

type SessionContext = {
  memory: BlackboardMemory;
  planner: PlannerAgent;
  researcher: ResearchAgent;
  risk: RiskAgent;
  strategy: StrategyAgent;
  critic: CriticAgent;
  executor: ExecutorAgent;
};

// ─── SwarmOrchestrator ────────────────────────────────────────────────────────
//
// Agent pipeline order (each agent writes to shared 0G-backed memory,
// and every subsequent agent reads prior outputs from that same memory):
//
//   1. Researcher  — fetches live on-chain pool data, saves researcher/report
//   2. Planner     — reads researcher/report, creates plan, saves planner/plan
//   3. Risk        — reads planner/plan + researcher/report, saves risk/assessments
//   4. Strategy    — reads all above, builds trade proposal, saves strategy/proposal
//   5. Critic      — reads all above, approves/rejects, saves critic/critique
//   6. Executor    — reads strategy/proposal + critic/critique, executes (or simulates)
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

export class SwarmOrchestrator {
  private readonly compute: ZGCompute;
  private readonly zgStorage: ZGStorage;
  private readonly sessionContexts = new Map<string, SessionContext>();

  private cycleHistory: SwarmCycleState[] = [];
  private running = false;

  constructor() {
    this.compute = new ZGCompute();
    this.zgStorage = new ZGStorage();
  }

  private createSessionContext(sessionId: string): SessionContext {
    const memory = new BlackboardMemory(
      this.zgStorage,
      `sessions/${sessionId}`,
    );
    return {
      memory,
      planner: new PlannerAgent(this.compute, memory),
      researcher: new ResearchAgent(this.compute, memory),
      risk: new RiskAgent(this.compute, memory),
      strategy: new StrategyAgent(this.compute, memory),
      critic: new CriticAgent(this.compute, memory),
      executor: new ExecutorAgent(memory),
    };
  }

  private getOrCreateSessionContext(sessionId: string): SessionContext {
    const existing = this.sessionContexts.get(sessionId);
    if (existing) return existing;

    const created = this.createSessionContext(sessionId);
    this.sessionContexts.set(sessionId, created);
    return created;
  }

  async init(): Promise<void> {
    // Initialise 0G Compute and 0G Storage in parallel
    await Promise.all([this.compute.init(), this.zgStorage.init()]);
    logger.info(
      "[Orchestrator] All agents ready — 0G Compute + 0G Storage connected",
    );
  }

  // ── Single cycle (blocking) ─────────────────────────────────────────────────

  async runCycle(
    sessionId = uuidv4(),
    walletAddress?: string,
  ): Promise<SwarmCycleState> {
    const cycleId = uuidv4();
    const state: SwarmCycleState = { cycleId, startedAt: Date.now() };
    const ctx = this.getOrCreateSessionContext(sessionId);
    logger.info(
      `\n${"=".repeat(60)}\n[Swarm] Cycle ${cycleId} starting (session=${sessionId}${walletAddress ? ` wallet=${walletAddress}` : ""})\n${"=".repeat(60)}`,
    );

    // Clear in-process cache for this cycle (0G Storage entries are permanent)
    ctx.memory.clear();

    try {
      // 1. Researcher runs first — fetches live on-chain data + wallet holdings, writes researcher/report
      state.research = await ctx.researcher.run(GOAL, {}, walletAddress);

      // 2. Planner reads researcher/report from memory, creates plan, writes planner/plan
      state.plan = await ctx.planner.run(GOAL);

      // 3. Risk reads planner/plan + researcher/report from memory, writes risk/assessments
      state.riskAssessments = await ctx.risk.run();

      // 4. Strategy reads plan + research + risk from memory, writes strategy/proposal
      const stratResult = await ctx.strategy.run();
      if (stratResult) state.strategy = stratResult;

      // 5. Critic reads all above from memory, writes critic/critique
      state.critique = await ctx.critic.run();

      // 6. Executor reads strategy/proposal + critic/critique from memory
      if (state.strategy) {
        state.execution = await ctx.executor.run();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[Swarm] Cycle ${cycleId} failed: ${msg}`);
    }

    state.completedAt = Date.now();
    const duration = ((state.completedAt - state.startedAt) / 1000).toFixed(1);
    logger.info(`[Swarm] Cycle ${cycleId} done in ${duration}s`);

    this.cycleHistory.push(state);
    return state;
  }

  // ── Streaming cycle (SSE) ───────────────────────────────────────────────────

  async *runCycleStream(
    sessionId = uuidv4(),
    walletAddress?: string,
  ): AsyncGenerator<SwarmEvent> {
    const cycleId = uuidv4();
    const ts = () => Date.now();

    yield { type: "cycle_start", cycleId, agentId: "orchestrator", ts: ts() };

    try {
      // Non-streaming agents emit agent_start / agent_done pairs
      for (const [agentId, runFn] of this.buildNonStreamingSteps(
        cycleId,
        sessionId,
        walletAddress,
      )) {
        yield { type: "agent_start", cycleId, agentId, ts: ts() };
        await runFn();
        yield { type: "agent_done", cycleId, agentId, ts: ts() };
      }

      const lastCycle = this.cycleHistory[this.cycleHistory.length - 1];
      yield {
        type: "cycle_done",
        cycleId,
        agentId: "orchestrator",
        data: lastCycle,
        ts: ts(),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      yield {
        type: "cycle_error",
        cycleId,
        agentId: "orchestrator",
        content: msg,
        ts: ts(),
      };
    }
  }

  private buildNonStreamingSteps(
    _cycleId: string,
    sessionId: string,
    walletAddress?: string,
  ): Array<[string, () => Promise<void>]> {
    const state: SwarmCycleState = {
      cycleId: _cycleId,
      startedAt: Date.now(),
    };
    const ctx = this.getOrCreateSessionContext(sessionId);
    ctx.memory.clear();
    this.cycleHistory.push(state);

    return [
      [
        "researcher",
        async () => {
          state.research = await ctx.researcher.run(GOAL, {}, walletAddress);
        },
      ],
      [
        "planner",
        async () => {
          state.plan = await ctx.planner.run(GOAL);
        },
      ],
      [
        "risk",
        async () => {
          state.riskAssessments = await ctx.risk.run();
        },
      ],
      [
        "strategy",
        async () => {
          const s = await ctx.strategy.run({}, walletAddress);
          if (s) state.strategy = s;
        },
      ],
      [
        "critic",
        async () => {
          state.critique = await ctx.critic.run();
        },
      ],
      [
        "executor",
        async () => {
          if (!state.strategy || !state.critique) return;
          state.execution = await ctx.executor.run();
          state.completedAt = Date.now();
        },
      ],
    ];
  }

  // ── Per-agent public runners ────────────────────────────────────────────────
  // Each method runs a single agent in isolation. The agent reads whatever
  // prior state is currently in shared memory and writes its output there.

  async runResearcher(
    sessionId: string,
    goal?: string,
    onChunk?: InferOptions["onChunk"],
    walletAddress?: string,
  ): Promise<ResearchReport> {
    logger.info(
      `[Orchestrator] 🔬 Researcher Agent called for session ${sessionId}${walletAddress ? ` (wallet=${walletAddress})` : ""}`,
    );
    return this.getOrCreateSessionContext(sessionId).researcher.run(
      goal ?? GOAL,
      onChunk ? { onChunk } : {},
      walletAddress,
    );
  }

  async runPlanner(
    sessionId: string,
    goal?: string,
    onChunk?: InferOptions["onChunk"],
  ): Promise<TradePlan> {
    logger.info(
      `[Orchestrator] 📋 Planner Agent called for session ${sessionId}`,
    );
    return this.getOrCreateSessionContext(sessionId).planner.run(
      goal ?? GOAL,
      onChunk ? { onChunk } : {},
    );
  }

  async runRisk(
    sessionId: string,
    onChunk?: InferOptions["onChunk"],
  ): Promise<RiskAssessment[]> {
    logger.info(`[Orchestrator] 🔍 Risk Agent called for session ${sessionId}`);
    return this.getOrCreateSessionContext(sessionId).risk.run(
      onChunk ? { onChunk } : {},
    );
  }

  async runStrategy(
    sessionId: string,
    onChunk?: InferOptions["onChunk"],
    walletAddress?: string,
  ): Promise<TradeStrategy | null> {
    logger.info(
      `[Orchestrator] 🎯 Strategy Agent called for session ${sessionId}`,
    );
    return this.getOrCreateSessionContext(sessionId).strategy.run(
      onChunk ? { onChunk } : {},
      walletAddress,
    );
  }

  async runCritic(
    sessionId: string,
    onChunk?: InferOptions["onChunk"],
  ): Promise<Critique> {
    logger.info(
      `[Orchestrator] 🎭 Critic Agent called for session ${sessionId}`,
    );
    return this.getOrCreateSessionContext(sessionId).critic.run(
      onChunk ? { onChunk } : {},
    );
  }

  async runExecutor(sessionId: string): Promise<ExecutionResult> {
    logger.info(
      `[Orchestrator] ⚡ Executor Agent called for session ${sessionId}`,
    );
    return this.getOrCreateSessionContext(sessionId).executor.run();
  }

  async fetchPrices(
    sessionId: string,
    tokens: string[],
  ): Promise<PriceQuoteResponse> {
    return this.getOrCreateSessionContext(
      sessionId,
    ).researcher.fetchTokenPrices(tokens);
  }

  async fetchMarketData(
    sessionId: string,
    tokens: string[],
  ): Promise<Record<string, CoinGeckoMarketData>> {
    const map =
      await this.getOrCreateSessionContext(
        sessionId,
      ).researcher.fetchCoinGeckoMarketData(tokens);
    return Object.fromEntries(map.entries());
  }

  // Generic SSE wrapper — yields agent_start, agent_done (with data), or cycle_error.
  async *runAgentStream(
    sessionId: string,
    agentId: string,
    runFn: () => Promise<unknown>,
  ): AsyncGenerator<SwarmEvent> {
    const cycleId = uuidv4();
    const ts = () => Date.now();
    yield { type: "agent_start", cycleId, agentId, ts: ts() };
    try {
      const data = await runFn();
      yield { type: "agent_done", cycleId, agentId, data, ts: ts() };
    } catch (err) {
      const content = err instanceof Error ? err.message : String(err);
      yield { type: "cycle_error", cycleId, agentId, content, ts: ts() };
    }
  }

  // ── History ─────────────────────────────────────────────────────────────────

  getMemory(sessionId?: string): MemoryEntry[] {
    if (sessionId) {
      return this.getOrCreateSessionContext(sessionId).memory.readAll();
    }

    return Array.from(this.sessionContexts.values())
      .flatMap((ctx) => ctx.memory.readAll())
      .sort((a, b) => a.ts - b.ts);
  }

  getHistory(): SwarmCycleState[] {
    return this.cycleHistory;
  }

  getLatest(): SwarmCycleState | undefined {
    return this.cycleHistory[this.cycleHistory.length - 1];
  }

  isRunning(): boolean {
    return this.running;
  }

  setRunning(v: boolean): void {
    this.running = v;
  }
}
