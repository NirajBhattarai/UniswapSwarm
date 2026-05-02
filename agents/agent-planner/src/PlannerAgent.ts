import { ZGCompute, type InferOptions } from "@swarm/compute";
import { BlackboardMemory } from "@swarm/memory";
import { logger } from "@swarm/shared";
import type {
  TradePlan,
  TradeConstraints,
  ResearchReport,
} from "@swarm/shared";
import { getConfig } from "@swarm/shared";
import {
  formatResearchForPlanner,
  narrativeToStrategy,
  buildParameterizedTasks,
} from "./formatters";

const SYSTEM_PROMPT = `You are the Planner agent in a Uniswap trading swarm.
Your job is to create a structured, actionable trading plan based on REAL on-chain data.

## YOUR INPUTS
1. **Research Report**: Live token candidates with liquidity, prices, volatility, and narrative context
2. **Goal**: User's trading objective (e.g., "maximize yield", "safe haven")
3. **Default Constraints**: Safety limits for slippage, position size, liquidity, and gas

## STRATEGY SELECTION CRITERIA
Choose strategy based on market conditions in the research report:

- **momentum**: Use when narrative is strong (DeFi/AI/L2) and candidates show directional price movement (>3% 24h change). Ride trending tokens with momentum signals.
- **arbitrage**: Use when narrative is neutral and you see price discrepancies between pools for the same token. Requires ≥2 candidates to compare.
- **lp_rotation**: Use when Fear & Greed <25 (defensive) OR narrative is safe_haven/staking. Rotate LP capital to highest-yield pools.

## TASK REQUIREMENTS
Each task MUST include:
1. **Specific token symbols** from research candidates (e.g., "AAVE", "UNI")
2. **Concrete thresholds** (e.g., "liquidity >$5M", "slippage <1.5%")
3. **Verifiable actions** (e.g., "validate liquidity", "execute trade")
4. **NO generic placeholders** — use actual data from the research report

## PROTOCOL CONTEXT
- The swarm routes via Uniswap Trading API covering V2, V3, V4, AND UniswapX
- Do NOT hardcode "V3" — say "Uniswap multi-protocol" or let API auto-route
- The \`protocol\` field in research shows which version was actually routed

## OUTPUT SCHEMA
Return ONLY valid JSON matching this schema — no commentary:

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
    { "agentId": "risk",     "action": "<specific validation with token symbols and thresholds>" },
    { "agentId": "strategy", "action": "<specific strategy with token symbols and parameters>" },
    { "agentId": "critic",   "action": "<specific critique focus with constraints>" },
    { "agentId": "executor", "action": "<specific execution with token symbols and routing>" }
  ],
  "rationale": "<2-3 sentences explaining why this strategy fits the current market conditions from research>"
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

    // Read structured research report from shared 0G-backed memory
    const report = this.memory.readValue<ResearchReport>("researcher/report");

    if (!report || !report.candidates || report.candidates.length === 0) {
      throw new Error(
        "[Planner] No research data found in shared memory. Researcher must run first.",
      );
    }

    // Extract narrative context from market summary
    const narrativeMatch = report.marketSummary.match(
      /\b(DeFi|AI|safe.?haven|L2|staking|neutral)\b/i,
    );
    const narrativeHint = narrativeMatch
      ? (narrativeMatch[1]!.toLowerCase().replace(/[^a-z]/g, "") as
          | "defi"
          | "ai"
          | "safehaven"
          | "l2"
          | "staking"
          | "neutral")
      : "neutral";

    // Parse Fear & Greed value from market summary
    const fearGreedMatch = report.marketSummary.match(
      /Fear\s*&\s*Greed.*?(\d+)\s*\/\s*100/i,
    );
    const fearGreedValue = fearGreedMatch
      ? parseInt(fearGreedMatch[1]!, 10)
      : 50;

    // Determine strategy based on narrative + market conditions
    const suggestedStrategy = narrativeToStrategy(
      narrativeHint,
      fearGreedValue,
    );

    logger.info(
      `[Planner] Narrative hint: ${narrativeHint}, Fear&Greed: ${fearGreedValue} → Suggested strategy: ${suggestedStrategy}`,
    );

    // Format research into structured, LLM-readable context
    const formattedResearch = formatResearchForPlanner(report);

    // Build parameterized tasks with actual token symbols and thresholds
    const parameterizedTasks = buildParameterizedTasks(
      suggestedStrategy,
      report.candidates,
      {
        maxSlippagePct: cfg.MAX_SLIPPAGE_PCT,
        minLiquidityUSD: cfg.MIN_LIQUIDITY_USD,
      },
    );

    const userPrompt = [
      `Goal: ${goal}`,
      `Default constraints: ${JSON.stringify(defaultConstraints)}`,
      `Suggested strategy (based on narrative): ${suggestedStrategy}`,
      ``,
      formattedResearch,
      ``,
      `EXAMPLE TASKS (use these as a template, but tailor to the actual research data):`,
      JSON.stringify(parameterizedTasks, null, 2),
    ].join("\n");

    const plan = await this.compute.inferJSON<TradePlan>(
      SYSTEM_PROMPT,
      userPrompt,
      opts,
    );

    // Hard safety caps — LLM cannot relax these
    plan.constraints.allowUnverified = false;
    plan.constraints.maxSlippagePct = Math.min(
      plan.constraints.maxSlippagePct,
      cfg.MAX_SLIPPAGE_PCT,
    );

    plan.createdAt = Date.now();

    // ── Write plan to shared 0G-backed memory ────────────────────────────────
    await this.memory.write(PlannerAgent.MEMORY_KEY, this.id, this.role, plan);
    logger.info(
      `[Planner] Plan saved to shared memory — strategy=${plan.strategy} (${plan.tasks.length} tasks)`,
    );
    return plan;
  }
}
