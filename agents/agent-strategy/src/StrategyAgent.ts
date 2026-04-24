import { ZGCompute, type InferOptions } from "@swarm/compute";
import { BlackboardMemory } from "@swarm/memory";
import { logger, getConfig } from "@swarm/shared";
import type {
  ResearchReport,
  RiskAssessment,
  TradePlan,
  TradeStrategy,
  TokenCandidate,
} from "@swarm/shared";

const SYSTEM_PROMPT = `You are the Strategy agent in a Uniswap trading swarm.
You convert validated research into a single, concrete trade proposal.

Rules:
- Only propose trades for tokens that PASSED risk assessment
- Choose the SINGLE best opportunity from the candidates
- Set realistic slippage — never exceed the plan's maxSlippagePct
- Never exceed the plan's maxPositionUSDC
- Calculate minAmountOutWei using slippage tolerance
- Output ONLY valid JSON:

{
  "type": "buy" | "sell" | "swap",
  "tokenIn": "<address>",
  "tokenOut": "<address>",
  "tokenInSymbol": "<symbol>",
  "tokenOutSymbol": "<symbol>",
  "amountInWei": "<amount as string>",
  "minAmountOutWei": "<amount as string>",
  "slippagePct": number,
  "poolFee": 500 | 3000 | 10000,
  "expectedOutputUSD": number,
  "estimatedGasUSD": number,
  "rationale": "<2–3 sentence explanation>"
}`;

export class StrategyAgent {
  static readonly MEMORY_KEY = "strategy/proposal";
  readonly id = "strategy";
  readonly role = "Strategist";

  private readonly compute: ZGCompute;
  private readonly memory: BlackboardMemory;

  constructor(compute: ZGCompute, memory: BlackboardMemory) {
    this.compute = compute;
    this.memory = memory;
  }

  async run(
    plan: TradePlan,
    report: ResearchReport,
    assessments: RiskAssessment[],
    opts: InferOptions = {}
  ): Promise<TradeStrategy | null> {
    const passed = assessments.filter((a) => a.passed);

    if (passed.length === 0) {
      logger.warn("[Strategy] No candidates passed risk assessment — skipping");
      await this.memory.write(
        StrategyAgent.MEMORY_KEY,
        this.id,
        this.role,
        null
      );
      return null;
    }

    logger.info(`[Strategy] Building trade from ${passed.length} passed candidates`);

    // Only pass research for candidates that cleared risk
    const passedAddresses = new Set(passed.map((a) => a.tokenAddress));
    const safeCandidates = report.candidates.filter((c: TokenCandidate) =>
      passedAddresses.has(c.address)
    );

    const cfg = getConfig();
    const context = this.memory.contextFor(StrategyAgent.MEMORY_KEY);

    const userPrompt = [
      `Plan:\n${JSON.stringify(plan, null, 2)}`,
      `Safe candidates:\n${JSON.stringify(safeCandidates, null, 2)}`,
      `Risk assessments (passed only):\n${JSON.stringify(passed, null, 2)}`,
      `Max position USDC: ${cfg.MAX_POSITION_USDC}`,
      context,
    ]
      .filter(Boolean)
      .join("\n\n");

    const strategy = await this.compute.inferJSON<TradeStrategy>(
      SYSTEM_PROMPT,
      userPrompt,
      { maxTokens: 1024, ...opts }
    );

    // Hard caps — LLM cannot exceed configured limits
    strategy.slippagePct = Math.min(
      strategy.slippagePct,
      plan.constraints.maxSlippagePct
    );

    await this.memory.write(
      StrategyAgent.MEMORY_KEY,
      this.id,
      this.role,
      strategy
    );
    logger.info(
      `[Strategy] Proposal: ${strategy.tokenInSymbol}→${strategy.tokenOutSymbol} via fee=${strategy.poolFee}`
    );
    return strategy;
  }
}
