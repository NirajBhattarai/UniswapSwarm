import { ZGCompute, type InferOptions } from "@swarm/compute";
import { BlackboardMemory } from "@swarm/memory";
import { logger } from "@swarm/shared";
import type { TradePlan, TradeConstraints } from "@swarm/shared";
import { getConfig } from "@swarm/shared";

const SYSTEM_PROMPT = `You are the Planner agent in a Uniswap trading swarm.
Your job is to create a structured, actionable trading plan for the cycle.

Rules:
- Always define a clear strategy type from: arbitrage, momentum, lp_rotation
- Set concrete, conservative constraints — protect capital above all else
- Assign specific tasks to: researcher, risk, strategy, critic, executor agents
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
    { "agentId": "researcher", "action": "<what to research>" },
    { "agentId": "risk",       "action": "<what to validate>" },
    { "agentId": "strategy",   "action": "<what strategy to build>" },
    { "agentId": "critic",     "action": "<what to critique>" },
    { "agentId": "executor",   "action": "<what to execute>" }
  ],
  "rationale": "<short explanation of strategy choice>"
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

  async run(goal: string, opts: InferOptions = {}): Promise<TradePlan> {
    logger.info(`[Planner] Planning cycle — goal="${goal}"`);

    const cfg = getConfig();
    const defaultConstraints: TradeConstraints = {
      maxSlippagePct: cfg.MAX_SLIPPAGE_PCT,
      maxPositionUSDC: cfg.MAX_POSITION_USDC,
      minLiquidityUSD: cfg.MIN_LIQUIDITY_USD,
      maxGasGwei: cfg.MAX_GAS_GWEI,
      allowUnverified: false,
    };

    const context = this.memory.contextFor(PlannerAgent.MEMORY_KEY);

    const userPrompt = [
      `Goal: ${goal}`,
      `Default constraints: ${JSON.stringify(defaultConstraints)}`,
      context,
    ]
      .filter(Boolean)
      .join("\n\n");

    const plan = await this.compute.inferJSON<TradePlan>(
      SYSTEM_PROMPT,
      userPrompt,
      { maxTokens: 1024, ...opts }
    );

    // Merge in hardcoded safety defaults — LLM cannot relax them
    plan.constraints.allowUnverified = false;
    plan.constraints.maxSlippagePct = Math.min(
      plan.constraints.maxSlippagePct,
      cfg.MAX_SLIPPAGE_PCT
    );

    plan.createdAt = Date.now();

    await this.memory.write(PlannerAgent.MEMORY_KEY, this.id, this.role, plan);
    logger.info(`[Planner] Plan created — strategy=${plan.strategy}`);
    return plan;
  }
}
