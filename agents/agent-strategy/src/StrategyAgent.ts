import { ZGCompute, type InferOptions } from "@swarm/compute";
import { BlackboardMemory } from "@swarm/memory";
import { logger, getConfig, isStablecoin } from "@swarm/shared";
import { ethers } from "ethers";
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

/**
 * Selects the best tokenIn from the user's wallet holdings.
 * Priority: stablecoin with highest USD value → ETH/WETH → null (UI asks user).
 */
function pickBestTokenIn(holdings: WalletHolding[]): WalletHolding | null {
  const stables = holdings.filter((h) =>
    isStablecoin({ symbol: h.symbol, address: h.address }),
  );
  if (stables.length > 0) {
    return stables.reduce((best, h) => (h.valueUSD > best.valueUSD ? h : best));
  }
  const eth = holdings.find(
    (h) =>
      h.symbol.toUpperCase() === "ETH" ||
      h.symbol.toUpperCase() === "WETH" ||
      h.address.toLowerCase() ===
        "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
  );
  return eth ?? null;
}

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

    // ── Wallet holdings — always fetch fresh from Alchemy when a wallet address
    //    is provided so the strategy agent has up-to-date balances even if the
    //    researcher ran earlier in the cycle.  Fall back to whatever the
    //    researcher stored in shared memory if the live fetch fails or no address
    //    is provided.
    let walletHoldings: WalletHolding[] | undefined;
    if (walletAddress) {
      try {
        walletHoldings = await this.fetchWalletHoldings(walletAddress);
        logger.info(
          `[Strategy] Live wallet fetch for ${walletAddress}: ${walletHoldings.length} holding(s)`,
        );
      } catch (err) {
        logger.warn(
          `[Strategy] Live wallet fetch failed — falling back to memory: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (!walletHoldings || walletHoldings.length === 0) {
      walletHoldings =
        this.memory.readValue<WalletHolding[]>("researcher/wallet_holdings") ??
        report.walletHoldings;
    }

    // Compute the best tokenIn now so both the happy-path AND the fallback paths
    // can use wallet-aware token selection instead of hardcoded addresses.
    const bestTokenIn =
      walletHoldings && walletHoldings.length > 0
        ? pickBestTokenIn(walletHoldings)
        : null;

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
        "[Strategy] No non-stablecoin candidates passed risk assessment — using synthetic WETH fallback",
      );
      const cfg2 = getConfig();

      // Use the user's actual best tokenIn (stablecoin > ETH/WETH from wallet).
      // Fall back to hardcoded USDC only when no wallet data is available.
      const fallbackTokenIn = bestTokenIn ?? {
        symbol: "USDC",
        address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        decimals: 6,
        balanceFormatted: cfg2.MAX_POSITION_USDC,
        priceUSD: 1.0,
        valueUSD: cfg2.MAX_POSITION_USDC,
      };
      const maxBudgetTokens =
        fallbackTokenIn.priceUSD > 0
          ? cfg2.MAX_POSITION_USDC / fallbackTokenIn.priceUSD
          : cfg2.MAX_POSITION_USDC;
      // Cap to 90 % of the held balance so we don't drain the wallet.
      const cappedAmount = Math.min(
        maxBudgetTokens,
        fallbackTokenIn.balanceFormatted * 0.9,
      );
      const amountIn = ethers.parseUnits(
        cappedAmount.toFixed(fallbackTokenIn.decimals > 8 ? 8 : fallbackTokenIn.decimals),
        fallbackTokenIn.decimals,
      );
      const expectedWethOut = cfg2.MAX_POSITION_USDC / 3200; // approx ETH price
      const minOut = BigInt(Math.round(expectedWethOut * 0.985 * 1e18)); // 1.5% slippage
      const synthetic: TradeStrategy = {
        type: "swap",
        tokenIn: fallbackTokenIn.address,
        tokenOut: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // WETH
        tokenInSymbol: fallbackTokenIn.symbol,
        tokenOutSymbol: "WETH",
        amountInWei: amountIn.toString(),
        minAmountOutWei: minOut.toString(),
        slippagePct: 1.5,
        poolFee: 500,
        expectedOutputUSD: cfg2.MAX_POSITION_USDC,
        estimatedGasUSD: 5,
        rationale:
          `Synthetic fallback: no candidates cleared risk. Swapping ${fallbackTokenIn.symbol}→WETH at the lowest fee tier for pipeline verification.`,
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
      bestTokenIn
        ? `Preferred tokenIn from user wallet: symbol="${bestTokenIn.symbol}" address="${bestTokenIn.address}" balance=${bestTokenIn.balanceFormatted.toFixed(6)} (~$${bestTokenIn.valueUSD.toFixed(2)} USD). ` +
          `Set tokenIn="${bestTokenIn.address}" and tokenInSymbol="${bestTokenIn.symbol}" unless a SELL trade of a held position overrides this.`
        : walletHoldings && walletHoldings.length > 0
          ? `User holds no stablecoins or ETH — tokenIn must be selected manually by the user. Leave tokenIn as the most sensible held asset if a SELL trade applies, otherwise use USDC as a fallback address.`
          : null,
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
      opts,
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
        `[Strategy] LLM proposed stablecoin tokenOut (${strategy.tokenOutSymbol}) — forcing wallet-aware WETH fallback`,
      );
      const overrideTokenIn = bestTokenIn ?? {
        symbol: "USDC",
        address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        decimals: 6,
        balanceFormatted: cfg.MAX_POSITION_USDC,
        priceUSD: 1.0,
        valueUSD: cfg.MAX_POSITION_USDC,
      };
      const overrideMaxTokens =
        overrideTokenIn.priceUSD > 0
          ? cfg.MAX_POSITION_USDC / overrideTokenIn.priceUSD
          : cfg.MAX_POSITION_USDC;
      const overrideCapped = Math.min(
        overrideMaxTokens,
        overrideTokenIn.balanceFormatted * 0.9,
      );
      const overrideAmountIn = ethers.parseUnits(
        overrideCapped.toFixed(overrideTokenIn.decimals > 8 ? 8 : overrideTokenIn.decimals),
        overrideTokenIn.decimals,
      );
      const expectedWethOut = cfg.MAX_POSITION_USDC / 3200;
      const minOut = BigInt(Math.round(expectedWethOut * 0.985 * 1e18));
      const overridden: TradeStrategy = {
        type: "swap",
        tokenIn: overrideTokenIn.address,
        tokenOut: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
        tokenInSymbol: overrideTokenIn.symbol,
        tokenOutSymbol: "WETH",
        amountInWei: overrideAmountIn.toString(),
        minAmountOutWei: minOut.toString(),
        slippagePct: Math.min(1.5, plan.constraints.maxSlippagePct),
        poolFee: 500,
        expectedOutputUSD: cfg.MAX_POSITION_USDC,
        estimatedGasUSD: 5,
        rationale:
          `Stablecoin → stablecoin swaps are forbidden (1:1 with no upside). Falling back to ${overrideTokenIn.symbol}→WETH at the lowest fee tier.`,
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

  // ── Wallet data ────────────────────────────────────────────────────────────

  /**
   * Fetches live wallet holdings via Alchemy JSON-RPC.
   * Stablecoins are priced at $1.00.  ETH is priced via a CoinGecko simple
   * price call.  Unknown ERC-20 tokens are skipped — we only need stablecoins
   * and ETH/WETH to drive the `pickBestTokenIn` selection.
   */
  private async fetchWalletHoldings(
    walletAddress: string,
  ): Promise<WalletHolding[]> {
    const cfg = getConfig();
    if (!cfg.ALCHEMY_API_KEY) {
      throw new Error(
        "[Strategy] ALCHEMY_API_KEY is not set — cannot fetch wallet holdings",
      );
    }

    const rpcUrl = `https://eth-mainnet.g.alchemy.com/v2/${cfg.ALCHEMY_API_KEY}`;
    const ZERO =
      "0x0000000000000000000000000000000000000000000000000000000000000000";

    // Batch: ETH native balance + all ERC-20 token balances in one round-trip.
    const batchResp = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([
        { jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [walletAddress, "latest"] },
        { jsonrpc: "2.0", id: 2, method: "alchemy_getTokenBalances", params: [walletAddress, "erc20"] },
      ]),
    });
    if (!batchResp.ok) {
      throw new Error(`Alchemy batch RPC failed: HTTP ${batchResp.status}`);
    }
    const batchData = (await batchResp.json()) as Array<{
      id: number;
      result?: unknown;
    }>;

    type TokenBalancesResult = {
      tokenBalances: Array<{ contractAddress: string; tokenBalance: string | null }>;
    };
    const ethHex = batchData.find((r) => r.id === 1)?.result as string | undefined;
    const tokenResult = batchData.find((r) => r.id === 2)?.result as
      | TokenBalancesResult
      | undefined;

    // ETH price — one CoinGecko call (no key needed).
    let ethPriceUSD = 3200;
    try {
      const cgResp = await fetch(
        "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",
      );
      if (cgResp.ok) {
        const cgData = (await cgResp.json()) as { ethereum?: { usd?: number } };
        ethPriceUSD = cgData.ethereum?.usd ?? ethPriceUSD;
      }
    } catch {
      // Non-fatal — use the hardcoded fallback price.
    }

    const holdings: WalletHolding[] = [];

    // Native ETH.
    if (ethHex) {
      const formatted = parseFloat(ethers.formatEther(BigInt(ethHex)));
      if (formatted >= 0.001) {
        holdings.push({
          symbol: "ETH",
          address: "ETH",
          decimals: 18,
          balanceFormatted: formatted,
          priceUSD: ethPriceUSD,
          valueUSD: formatted * ethPriceUSD,
        });
      }
    }

    // ERC-20 tokens — we only need stablecoins so skip anything else to avoid
    // the cost of resolving metadata for unknown tokens.
    const nonZero = (tokenResult?.tokenBalances ?? []).filter(
      (t) => t.tokenBalance && t.tokenBalance !== ZERO,
    );
    if (nonZero.length > 0) {
      const metaResp = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          nonZero.map((t, i) => ({
            jsonrpc: "2.0",
            id: i + 1,
            method: "alchemy_getTokenMetadata",
            params: [t.contractAddress],
          })),
        ),
      });
      if (metaResp.ok) {
        const metaData = (await metaResp.json()) as Array<{
          id: number;
          result?: { symbol?: string; decimals?: number };
        }>;
        for (const meta of metaData) {
          const token = nonZero[meta.id - 1];
          if (!token || !meta.result) continue;
          const symbol = (meta.result.symbol ?? "").toUpperCase();
          const decimals = meta.result.decimals ?? 18;
          if (!symbol) continue;
          if (!isStablecoin({ symbol, address: token.contractAddress })) continue;
          const raw = BigInt(token.tokenBalance ?? "0");
          const formatted = parseFloat(ethers.formatUnits(raw, decimals));
          if (formatted < 0.01) continue;
          holdings.push({
            symbol,
            address: token.contractAddress,
            decimals,
            balanceFormatted: formatted,
            priceUSD: 1.0,
            valueUSD: formatted,
          });
        }
      }
    }

    return holdings;
  }
}
