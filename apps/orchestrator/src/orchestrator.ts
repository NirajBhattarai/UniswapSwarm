import { v4 as uuidv4 } from "uuid";
import { ZGCompute } from "@swarm/compute";
import { BlackboardMemory } from "@swarm/memory";
import { PlannerAgent } from "@swarm/agent-planner";
import { ResearchAgent } from "@swarm/agent-researcher";
import { RiskAgent } from "@swarm/agent-risk";
import { StrategyAgent } from "@swarm/agent-strategy";
import { CriticAgent } from "@swarm/agent-critic";
import { ExecutorAgent } from "@swarm/agent-executor";
import { logger } from "@swarm/shared";
import type { SwarmCycleState, SwarmEvent } from "@swarm/shared";

const GOAL = "Identify and execute profitable, low-risk token swaps on Uniswap V3 (Ethereum mainnet). Prioritise capital preservation over profit.";

// ─── SwarmOrchestrator ────────────────────────────────────────────────────────
//
// Coordinates the full agent pipeline per cycle:
//   Planner → Researcher → Risk → Strategy → Critic → Executor
//
// Agents share a single BlackboardMemory instance so every agent can read
// all previous agents' structured outputs before acting.
// ─────────────────────────────────────────────────────────────────────────────

export class SwarmOrchestrator {
  private readonly compute: ZGCompute;

  // Planner + researcher + risk share the same compute client
  private readonly planner: PlannerAgent;
  private readonly researcher: ResearchAgent;
  private readonly risk: RiskAgent;
  private readonly strategy: StrategyAgent;
  private readonly critic: CriticAgent;
  private readonly executor: ExecutorAgent;

  private cycleHistory: SwarmCycleState[] = [];
  private running = false;

  constructor() {
    this.compute = new ZGCompute();
    const memory = new BlackboardMemory(); // shared per-cycle — cleared each cycle

    this.planner = new PlannerAgent(this.compute, memory);
    this.researcher = new ResearchAgent(this.compute, memory);
    this.risk = new RiskAgent(this.compute, memory);
    this.strategy = new StrategyAgent(this.compute, memory);
    this.critic = new CriticAgent(this.compute, memory);
    this.executor = new ExecutorAgent(memory);
  }

  async init(): Promise<void> {
    await this.compute.init();
    logger.info("[Orchestrator] All agents ready");
  }

  // ── Single cycle (blocking) ─────────────────────────────────────────────────

  async runCycle(): Promise<SwarmCycleState> {
    const cycleId = uuidv4();
    const state: SwarmCycleState = { cycleId, startedAt: Date.now() };
    logger.info(`\n${"=".repeat(60)}\n[Swarm] Cycle ${cycleId} starting\n${"=".repeat(60)}`);

    try {
      state.plan = await this.planner.run(GOAL);
      state.research = await this.researcher.run(state.plan);
      state.riskAssessments = await this.risk.run(state.plan, state.research);
      const stratResult = await this.strategy.run(
        state.plan,
        state.research,
        state.riskAssessments
      );
      if (stratResult) state.strategy = stratResult;
      state.critique = await this.critic.run(
        state.plan,
        state.research,
        state.riskAssessments,
        state.strategy ?? null
      );

      if (state.strategy) {
        state.execution = await this.executor.run(state.strategy, state.critique);
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
    _cycleId: string
  ): Array<[string, () => Promise<void>]> {
    const state: SwarmCycleState = {
      cycleId: _cycleId,
      startedAt: Date.now(),
    };
    this.cycleHistory.push(state);

    return [
      [
        "planner",
        async () => {
          state.plan = await this.planner.run(GOAL);
        },
      ],
      [
        "researcher",
        async () => {
          if (!state.plan) return;
          state.research = await this.researcher.run(state.plan);
        },
      ],
      [
        "risk",
        async () => {
          if (!state.plan || !state.research) return;
          state.riskAssessments = await this.risk.run(state.plan, state.research);
        },
      ],
      [
        "strategy",
        async () => {
          if (!state.plan || !state.research || !state.riskAssessments) return;
          const s = await this.strategy.run(
            state.plan,
            state.research,
            state.riskAssessments
          );
          if (s) state.strategy = s;
        },
      ],
      [
        "critic",
        async () => {
          if (!state.plan || !state.research || !state.riskAssessments) return;
          state.critique = await this.critic.run(
            state.plan,
            state.research,
            state.riskAssessments,
            state.strategy ?? null
          );
        },
      ],
      [
        "executor",
        async () => {
          if (!state.strategy || !state.critique) return;
          state.execution = await this.executor.run(state.strategy, state.critique);
          state.completedAt = Date.now();
        },
      ],
    ];
  }

  // ── History ─────────────────────────────────────────────────────────────────

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
