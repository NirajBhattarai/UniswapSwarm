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

  // Agents are re-created each cycle with a fresh BlackboardMemory backed
  // by the shared ZGStorage instance so writes persist to 0G network.
  private readonly planner: PlannerAgent;
  private readonly researcher: ResearchAgent;
  private readonly risk: RiskAgent;
  private readonly strategy: StrategyAgent;
  private readonly critic: CriticAgent;
  private readonly executor: ExecutorAgent;

  // Shared blackboard — cleared at the start of each cycle, 0G-backed
  private readonly memory: BlackboardMemory;

  private cycleHistory: SwarmCycleState[] = [];
  private running = false;

  constructor() {
    this.compute = new ZGCompute();
    this.zgStorage = new ZGStorage();

    // Pass ZGStorage to BlackboardMemory so every agent write is persisted
    // to the 0G Storage network as an on-chain audit trail.
    this.memory = new BlackboardMemory(this.zgStorage);

    this.planner = new PlannerAgent(this.compute, this.memory);
    this.researcher = new ResearchAgent(this.compute, this.memory);
    this.risk = new RiskAgent(this.compute, this.memory);
    this.strategy = new StrategyAgent(this.compute, this.memory);
    this.critic = new CriticAgent(this.compute, this.memory);
    this.executor = new ExecutorAgent(this.memory);
  }

  async init(): Promise<void> {
    // Initialise 0G Compute and 0G Storage in parallel
    await Promise.all([this.compute.init(), this.zgStorage.init()]);
    logger.info(
      "[Orchestrator] All agents ready — 0G Compute + 0G Storage connected",
    );
  }

  // ── Single cycle (blocking) ─────────────────────────────────────────────────

  async runCycle(): Promise<SwarmCycleState> {
    const cycleId = uuidv4();
    const state: SwarmCycleState = { cycleId, startedAt: Date.now() };
    logger.info(
      `\n${"=".repeat(60)}\n[Swarm] Cycle ${cycleId} starting\n${"=".repeat(60)}`,
    );

    // Clear in-process cache for this cycle (0G Storage entries are permanent)
    this.memory.clear();

    try {
      // 1. Researcher runs first — fetches live on-chain data, writes researcher/report
      state.research = await this.researcher.run(GOAL);

      // 2. Planner reads researcher/report from memory, creates plan, writes planner/plan
      state.plan = await this.planner.run(GOAL);

      // 3. Risk reads planner/plan + researcher/report from memory, writes risk/assessments
      state.riskAssessments = await this.risk.run();

      // 4. Strategy reads plan + research + risk from memory, writes strategy/proposal
      const stratResult = await this.strategy.run();
      if (stratResult) state.strategy = stratResult;

      // 5. Critic reads all above from memory, writes critic/critique
      state.critique = await this.critic.run();

      // 6. Executor reads strategy/proposal + critic/critique from memory
      if (state.strategy) {
        state.execution = await this.executor.run();
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

  async *runCycleStream(): AsyncGenerator<SwarmEvent> {
    const cycleId = uuidv4();
    const ts = () => Date.now();

    yield { type: "cycle_start", cycleId, agentId: "orchestrator", ts: ts() };

    try {
      // Non-streaming agents emit agent_start / agent_done pairs
      for (const [agentId, runFn] of this.buildNonStreamingSteps(cycleId)) {
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
  ): Array<[string, () => Promise<void>]> {
    const state: SwarmCycleState = {
      cycleId: _cycleId,
      startedAt: Date.now(),
    };
    this.cycleHistory.push(state);

    return [
      [
        "researcher",
        async () => {
          state.research = await this.researcher.run(GOAL);
        },
      ],
      [
        "planner",
        async () => {
          state.plan = await this.planner.run(GOAL);
        },
      ],
      [
        "risk",
        async () => {
          state.riskAssessments = await this.risk.run();
        },
      ],
      [
        "strategy",
        async () => {
          const s = await this.strategy.run();
          if (s) state.strategy = s;
        },
      ],
      [
        "critic",
        async () => {
          state.critique = await this.critic.run();
        },
      ],
      [
        "executor",
        async () => {
          if (!state.strategy || !state.critique) return;
          state.execution = await this.executor.run();
          state.completedAt = Date.now();
        },
      ],
    ];
  }

  // ── Per-agent public runners ────────────────────────────────────────────────
  // Each method runs a single agent in isolation. The agent reads whatever
  // prior state is currently in shared memory and writes its output there.

  async runResearcher(
    goal?: string,
    onChunk?: InferOptions["onChunk"],
  ): Promise<ResearchReport> {
    return this.researcher.run(goal ?? GOAL, onChunk ? { onChunk } : {});
  }

  async runPlanner(
    goal?: string,
    onChunk?: InferOptions["onChunk"],
  ): Promise<TradePlan> {
    return this.planner.run(goal ?? GOAL, onChunk ? { onChunk } : {});
  }

  async runRisk(onChunk?: InferOptions["onChunk"]): Promise<RiskAssessment[]> {
    return this.risk.run(onChunk ? { onChunk } : {});
  }

  async runStrategy(
    onChunk?: InferOptions["onChunk"],
  ): Promise<TradeStrategy | null> {
    return this.strategy.run(onChunk ? { onChunk } : {});
  }

  async runCritic(onChunk?: InferOptions["onChunk"]): Promise<Critique> {
    return this.critic.run(onChunk ? { onChunk } : {});
  }

  async runExecutor(): Promise<ExecutionResult> {
    return this.executor.run();
  }

  async fetchPrices(tokens: string[]): Promise<PriceQuoteResponse> {
    return this.researcher.fetchTokenPrices(tokens);
  }

  async fetchMarketData(
    tokens: string[],
  ): Promise<Record<string, CoinGeckoMarketData>> {
    const map = await this.researcher.fetchCoinGeckoMarketData(tokens);
    return Object.fromEntries(map.entries());
  }

  // Generic SSE wrapper — yields agent_start, agent_done (with data), or cycle_error.
  async *runAgentStream(
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

  getMemory(): MemoryEntry[] {
    return this.memory.readAll();
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
