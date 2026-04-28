import { ZGCompute, type InferOptions } from "@swarm/compute";
import { BlackboardMemory } from "@swarm/memory";
import { logger, getConfig, isStablecoin } from "@swarm/shared";
import type {
  ResearchReport,
  RiskAssessment,
  TradePlan,
  TradeStrategy,
  TokenCandidate,
  WalletHolding,
} from "@swarm/shared";

const SYSTEM_PROMPT = `You are the Strategy agent in a Uniswap trading swarm.
You convert validated research into a single, concrete trade proposal.

Rules:
- Only propose trades for tokens that PASSED risk assessment
- Choose the SINGLE best opportunity from the candidates
- Set realistic slippage — never exceed the plan's maxSlippagePct
- Never exceed the plan's maxPositionUSDC
- Calculate minAmountOutWei using slippage tolerance
- NEVER propose a stablecoin → stablecoin swap. The user already holds
  USD-pegged value, so swapping to another stablecoin (USDC ↔ USDT,
  DAI ↔ USDC, USDC ↔ FRAX, etc.) is a 1:1 trade with zero economic upside
  and only burns gas + slippage. tokenIn may be a stablecoin (typically
  USDC), but tokenOut MUST be a non-stablecoin asset (WETH, WBTC, ARB,
  UNI, LINK, etc.). If the only safe candidates are stablecoins, return
  the synthetic USDC→WETH fallback you receive in the prompt instead of
  inventing a stable→stable trade.

Wallet-aware trading (applies when "Wallet holdings" are in the prompt):
- Review the wallet holdings alongside the risk-passed candidates
- For a holding marked EXIT or REDUCE in positionAdvice: prefer a SELL trade
  (tokenIn = the declining held token, tokenOut = USDC or WETH)
  * amountInWei for a REDUCE = 50% of the held balance (in Wei)
  * amountInWei for an EXIT  = 100% of the held balance (in Wei)
  * Selling a bad performer takes priority over buying a new token
- For a holding marked ADD that is also in the risk-passed candidates: prefer
  increasing that position (tokenIn = USDC, tokenOut = the held token)
- For a holding marked HOLD: do not trade it — look for better opportunities
- If no holdings advise action, fall back to the standard BUY flow (USDC → best candidate)
- NEVER propose selling a stablecoin holding (USDC, USDT, DAI etc.) — those are source funds

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
    opts: InferOptions = {},
    walletAddress?: string,
  ): Promise<TradeStrategy | null> {
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

    // Read wallet holdings written by the Researcher (if any)
    const walletHoldings =
      this.memory.readValue<WalletHolding[]>("researcher/wallet_holdings") ??
      report.walletHoldings;

    // Drop stablecoins from the candidate pool BEFORE the LLM sees them.
    // The trade always starts from USDC (or another stable) so a stablecoin
    // tokenOut is a 1:1 swap with no economic upside. Filtering here means
    // the LLM never has the option to pick e.g. USDT as tokenOut.
    const passed = assessments
      .filter((a) => a.passed)
      .filter((a) => {
        const stable = isStablecoin({
          symbol: a.symbol,
          address: a.tokenAddress,
        });
        if (stable) {
          logger.info(
            `[Strategy] Excluding stablecoin candidate from tokenOut pool: ${a.symbol ?? a.tokenAddress}`,
          );
        }
        return !stable;
      });

    if (passed.length === 0) {
      logger.warn(
        "[Strategy] No non-stablecoin candidates passed risk assessment — using synthetic USDC→WETH fallback",
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

    // Only use research for candidates that cleared risk AND are non-stable
    const passedAddresses = new Set(passed.map((a) => a.tokenAddress));
    const safeCandidates = report.candidates
      .filter((c: TokenCandidate) => passedAddresses.has(c.address))
      .filter(
        (c: TokenCandidate) =>
          !isStablecoin({ symbol: c.symbol, address: c.address }),
      );

    const cfg = getConfig();
    const context = this.memory.contextFor(StrategyAgent.MEMORY_KEY);

    // Build wallet holdings section for the prompt (gives LLM position-aware context)
    let walletSection: string | null = null;
    if (walletHoldings && walletHoldings.length > 0) {
      const holdingLines = walletHoldings
        .map(
          (h) =>
            `  ${h.symbol}: ${h.balanceFormatted.toFixed(6)} @ $${h.priceUSD.toFixed(4)} = $${h.valueUSD.toFixed(2)} USD  (address: ${h.address})`,
        )
        .join("\n");
      const adviceLines =
        report.positionAdvice && report.positionAdvice.length > 0
          ? report.positionAdvice
              .map((a) => `  ${a.symbol}: ${a.action} — ${a.rationale}`)
              .join("\n")
          : "  (no position advice from researcher)";
      walletSection =
        `Wallet holdings:\n${holdingLines}\n\n` +
        `Position advice from researcher:\n${adviceLines}`;
    }

    const userPrompt = [
      `Plan:\n${JSON.stringify(plan, null, 2)}`,
      `Safe candidates (non-stablecoins only):\n${JSON.stringify(safeCandidates, null, 2)}`,
      `Risk assessments (passed, non-stablecoins only):\n${JSON.stringify(passed, null, 2)}`,
      `Max position USDC: ${cfg.MAX_POSITION_USDC}`,
      walletSection,
      `IMPORTANT: tokenOut MUST be one of the candidates listed above. ` +
        `Do NOT pick USDC, USDT, DAI or any other stablecoin as tokenOut — ` +
        `that is forbidden by policy.`,
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

    // ── Last-resort safety net: if the LLM ignored the filter and still
    //    proposed a stablecoin↔stablecoin swap, override with the
    //    synthetic USDC→WETH fallback rather than emit a meaningless trade.
    //
    //    Exception: a SELL trade (non-stable tokenIn → stable tokenOut) is
    //    intentional when the wallet position advice says EXIT/REDUCE — allow it.
    const tokenInIsStable = isStablecoin({
      symbol: strategy.tokenInSymbol,
      address: strategy.tokenIn,
    });
    const tokenOutIsStable = isStablecoin({
      symbol: strategy.tokenOutSymbol,
      address: strategy.tokenOut,
    });

    // A non-stable → stable SELL is legitimate when the user holds that token
    // and the researcher advised EXIT or REDUCE.
    const isSellOfHolding =
      !tokenInIsStable &&
      tokenOutIsStable &&
      walletHoldings?.some(
        (h) =>
          h.address.toLowerCase() === strategy.tokenIn.toLowerCase() ||
          h.symbol.toUpperCase() === strategy.tokenInSymbol.toUpperCase(),
      );

    if (tokenOutIsStable && !isSellOfHolding) {
      logger.warn(
        `[Strategy] LLM proposed stablecoin tokenOut (${strategy.tokenOutSymbol}) — forcing synthetic USDC→WETH fallback`,
      );
      const amountIn = BigInt(Math.round(cfg.MAX_POSITION_USDC * 1e6));
      const expectedWethOut = cfg.MAX_POSITION_USDC / 3200;
      const minOut = BigInt(Math.round(expectedWethOut * 0.985 * 1e18));
      const overridden: TradeStrategy = {
        type: "swap",
        tokenIn: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        tokenOut: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
        tokenInSymbol: "USDC",
        tokenOutSymbol: "WETH",
        amountInWei: amountIn.toString(),
        minAmountOutWei: minOut.toString(),
        slippagePct: Math.min(1.5, plan.constraints.maxSlippagePct),
        poolFee: 500,
        expectedOutputUSD: cfg.MAX_POSITION_USDC,
        estimatedGasUSD: 5,
        rationale:
          "Stablecoin → stablecoin swaps are forbidden (1:1 with no upside). Falling back to a minimal USDC→WETH swap at the lowest fee tier.",
      };
      await this.memory.write(
        StrategyAgent.MEMORY_KEY,
        this.id,
        this.role,
        overridden,
      );
      logger.info(
        `[Strategy] Proposal (override): ${overridden.tokenInSymbol}→${overridden.tokenOutSymbol} via fee=${overridden.poolFee}`,
      );
      return overridden;
    }
    // tokenIn-is-stable + tokenOut-is-not-stable is the normal BUY case
    // (e.g. USDC → WETH), so we let it through.
    // non-stable tokenIn + stable tokenOut is a valid SELL of a held position.
    void tokenInIsStable;
    void isSellOfHolding;

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
