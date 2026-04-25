import { ZGCompute, type InferOptions } from "@swarm/compute";
import { BlackboardMemory } from "@swarm/memory";
import { logger } from "@swarm/shared";
import type { TradePlan, TradeConstraints } from "@swarm/shared";
import { getConfig } from "@swarm/shared";

const SYSTEM_PROMPT = `You are the Planner agent in a Uniswap trading swarm.
Your job is to create a structured, actionable trading plan for the cycle.

IMPORTANT: The Researcher agent has already run and saved on-chain market data
to shared memory. You will receive it below. Use it to tailor the plan
to current market conditions — e.g. choose strategy type based on real pool data.

Rules:
- Always define a clear strategy type from: arbitrage, momentum, lp_rotation
- Set concrete, conservative constraints — protect capital above all else
- Assign specific tasks to: risk, strategy, critic, executor agents
- Output ONLY valid JSON matching exactly the schema below — no commentary

Schema:
{
  "goal": "<one-sentence goal>",
  "strategy": "momentum" | "arbitrage" | "lp_rotation",
  "constraints": {
    "maxSlippagePct": number,
    "maxPositionUSDC": number,
    "minLiquidityUSD": number,
    "maxGasGwei": number,
    "allowUnverified": false
  },
  "tasks": [
    { "agentId": "risk",     "action": "<what to validate>" },
    { "agentId": "strategy", "action": "<what strategy to build>" },
    { "agentId": "critic",   "action": "<what to critique>" },
    { "agentId": "executor", "action": "<what to execute>" }
  ],
  "rationale": "<short explanation of strategy choice based on the research data>"
}`;

export class PlannerAgent {
  static readonly MEMORY_KEY = "planner/plan";
  readonly id = "planner";
  readonly role = "Planner";

  private readonly compute: ZGCompute;
  private readonly memory: BlackboardMemory;

  constructor(compute: ZGCompute, memory: BlackboardMemory) {
    this.compute = compute;
    this.memory = memory;
  }

  /**
   * Planner runs SECOND — after Researcher has written market data to shared memory.
   * contextFor() pulls the researcher/report from 0G-backed memory and injects it
   * into the LLM prompt so the plan is grounded in real on-chain data.
   */
  async run(goal: string, opts: InferOptions = {}): Promise<TradePlan> {
    logger.info(`[Planner] Reading research from shared memory and planning…`);

    const cfg = getConfig();
    const defaultConstraints: TradeConstraints = {
      maxSlippagePct: cfg.MAX_SLIPPAGE_PCT,
      maxPositionUSDC: cfg.MAX_POSITION_USDC,
      minLiquidityUSD: cfg.MIN_LIQUIDITY_USD,
      maxGasGwei: cfg.MAX_GAS_GWEI,
      allowUnverified: false,
    };

    // Reads researcher/report from shared 0G-backed memory
    const context = this.memory.contextFor(PlannerAgent.MEMORY_KEY);

    const userPrompt = [
      `Goal: ${goal}`,
      `Default constraints: ${JSON.stringify(defaultConstraints)}`,
      context, // <─ contains Researcher’s report from 0G memory
    ]
      .filter(Boolean)
      .join("\n\n");

    const plan = await this.compute.inferJSON<TradePlan>(
      SYSTEM_PROMPT,
      userPrompt,
      { maxTokens: 1024, ...opts },
    );

    // Hard safety caps — LLM cannot relax these
    plan.constraints.allowUnverified = false;
    plan.constraints.maxSlippagePct = Math.min(
      plan.constraints.maxSlippagePct,
      cfg.MAX_SLIPPAGE_PCT,
    );

    plan.createdAt = Date.now();

    // ── Write plan to shared 0G-backed memory ────────────────────────────────
    // Risk, Strategy, Critic, Executor all read this via memory.readValue()
    await this.memory.write(PlannerAgent.MEMORY_KEY, this.id, this.role, plan);
    logger.info(
      `[Planner] Plan saved to shared memory — strategy=${plan.strategy}`,
    );
    return plan;
  }
}
