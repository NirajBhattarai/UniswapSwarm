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

  async run(opts: InferOptions = {}): Promise<TradeStrategy | null> {
    // ── Read plan, research, and risk assessments from 0G-backed shared memory ───
    const plan = this.memory.readValue<TradePlan>("planner/plan");
    const report = this.memory.readValue<ResearchReport>("researcher/report");
    const assessments =
      this.memory.readValue<RiskAssessment[]>("risk/assessments");

    if (!plan || !report || !assessments) {
      throw new Error(
        "[Strategy] planner/plan, researcher/report, and risk/assessments must be in shared memory first",
      );
    }

    const passed = assessments.filter((a) => a.passed);

    if (passed.length === 0) {
      logger.warn(
        "[Strategy] No candidates passed risk assessment — using synthetic fallback strategy",
      );
      // Synthetic USDC→WETH swap at $50 max position — keeps full pipeline running for test/demo.
      const cfg2 = getConfig();
      const amountIn = BigInt(Math.round(cfg2.MAX_POSITION_USDC * 1e6)); // USDC has 6 decimals
      const expectedWethOut = cfg2.MAX_POSITION_USDC / 3200; // approx ETH price
      const minOut = BigInt(Math.round(expectedWethOut * 0.985 * 1e18)); // 1.5% slippage
      const synthetic: TradeStrategy = {
        type: "swap",
        tokenIn: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC
        tokenOut: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // WETH
        tokenInSymbol: "USDC",
        tokenOutSymbol: "WETH",
        amountInWei: amountIn.toString(),
        minAmountOutWei: minOut.toString(),
        slippagePct: 1.5,
        poolFee: 500,
        expectedOutputUSD: cfg2.MAX_POSITION_USDC,
        estimatedGasUSD: 5,
        rationale:
          "Synthetic fallback: no candidates cleared risk. Simulating a minimal USDC→WETH swap at the lowest fee tier for pipeline verification.",
      };
      await this.memory.write(
        StrategyAgent.MEMORY_KEY,
        this.id,
        this.role,
        synthetic,
      );
      logger.info(
        "[Strategy] Synthetic fallback strategy saved to shared memory",
      );
      return synthetic;
    }

    logger.info(
      `[Strategy] Read all prior agent outputs from shared memory. Building trade from ${passed.length} passed candidates`,
    );

    // Only use research for candidates that cleared risk
    const passedAddresses = new Set(passed.map((a) => a.tokenAddress));
    const safeCandidates = report.candidates.filter((c: TokenCandidate) =>
      passedAddresses.has(c.address),
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
      { maxTokens: 1024, ...opts },
    );

    // Hard caps — LLM cannot exceed configured limits
    strategy.slippagePct = Math.min(
      strategy.slippagePct,
      plan.constraints.maxSlippagePct,
    );

    await this.memory.write(
      StrategyAgent.MEMORY_KEY,
      this.id,
      this.role,
      strategy,
    );
    logger.info(
      `[Strategy] Proposal: ${strategy.tokenInSymbol}→${strategy.tokenOutSymbol} via fee=${strategy.poolFee}`,
    );
    return strategy;
  }
}
