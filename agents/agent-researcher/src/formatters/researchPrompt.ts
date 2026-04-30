import {
  isStablecoin,
  type TokenCandidate,
  type WalletHolding,
} from "@swarm/shared";

import type {
  CoinGeckoMarketData,
  NarrativeSignal,
  PoolSnapshot,
} from "../core/types";

interface ResearchPromptConfig {
  MAX_SLIPPAGE_PCT: number;
  MAX_POSITION_USDC: number;
  MIN_LIQUIDITY_USD: number;
}

interface BuildResearchPromptArgs {
  goal: string;
  cfg: ResearchPromptConfig;
  pools: PoolSnapshot[];
  marketDataText: string;
  narrativeText: string;
  context: string;
  walletHoldings?: WalletHolding[];
}

export function buildMarketDataText(
  marketData: Map<string, CoinGeckoMarketData>,
): string {
  if (marketData.size === 0) return "";

  const lines = Array.from(marketData.entries()).map(([sym, d]) => {
    const parts = [
      `${sym}: price=$${(d.price_usd ?? 0).toFixed(4)}`,
      `vol24h=$${((d.volume_24h_usd ?? 0) / 1e6).toFixed(1)}M`,
      `chg24h=${(d.price_change_24h_pct ?? 0).toFixed(2)}%`,
    ];
    if (d.price_change_7d_pct != null) {
      parts.push(`chg7d=${d.price_change_7d_pct.toFixed(2)}%`);
    }
    if (d.price_change_30d_pct != null) {
      parts.push(`chg30d=${d.price_change_30d_pct.toFixed(2)}%`);
    }
    parts.push(`mcap=$${((d.market_cap_usd ?? 0) / 1e9).toFixed(2)}B`);
    return parts.join(" ");
  });
  return `\nLive market data (CoinGecko 24h + DeFi Llama 7d/30d):\n${lines.join("\n")}`;
}

export function buildNarrativeText(narrativeSignal: NarrativeSignal): string {
  return [
    `Market Sentiment (Fear & Greed Index): ${narrativeSignal.fearGreedValue}/100 - "${narrativeSignal.fearGreedLabel}"`,
    `Detected Narrative: ${narrativeSignal.narrative}`,
    narrativeSignal.trendingTokens.length > 0
      ? `CoinGecko Trending Tokens (right now): ${narrativeSignal.trendingTokens.join(", ")}`
      : null,
    narrativeSignal.topHeadlines.length > 0
      ? `Recent News & Community Headlines:\n${narrativeSignal.topHeadlines.map((h) => `  * ${h}`).join("\n")}`
      : null,
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildResearchPrompt(args: BuildResearchPromptArgs): string {
  const {
    goal,
    cfg,
    pools,
    marketDataText,
    narrativeText,
    context,
    walletHoldings,
  } = args;

  // Send all qualifying pools sorted by liquidityUSD descending so the LLM can
  // evaluate the full opportunity set. No arbitrary row cap — deeper context
  // allows the model to surface more unique non-stablecoin candidates.
  const compactPools = [...pools]
    .sort((a, b) => b.liquidityUSD - a.liquidityUSD)
    .map((p) => ({
      tokenAddress: p.tokenAddress,
      tokenSymbol: p.tokenSymbol,
      tokenName: p.tokenName,
      baseTokenSymbol: p.baseTokenSymbol,
      poolAddress: p.poolAddress,
      protocol: p.protocol,
      feePct: p.feePct,
      currentPrice: p.currentPrice,
      liquidityUSD: p.liquidityUSD,
      priceLabel: p.priceLabel,
    }));

  let walletSection: string | null = null;
  if (walletHoldings && walletHoldings.length > 0) {
    const lines = walletHoldings.map(
      (h) =>
        `  ${h.symbol}: ${h.balanceFormatted.toFixed(6)} tokens @ $${h.priceUSD.toFixed(4)} = $${h.valueUSD.toFixed(2)} USD`,
    );
    walletSection = `Current wallet holdings (analyze each non-stablecoin for positionAdvice):\n${lines.join("\n")}`;
  }

  return [
    `Trading goal: ${goal}`,
    `Default constraints: maxSlippage=${cfg.MAX_SLIPPAGE_PCT}%, maxPosition=$${cfg.MAX_POSITION_USDC} USDC, minLiquidity=$${cfg.MIN_LIQUIDITY_USD.toLocaleString()}`,
    `Live Uniswap multi-protocol pool data (${compactPools.length} pools, sorted by liquidityUSD desc) - each entry has a pre-computed \`tokenAddress\` - use it directly as the candidate \`address\` field:\n${JSON.stringify(compactPools)}`,
    marketDataText,
    `\nReal-time narrative signal:\n${narrativeText}`,
    walletSection,
    context,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function enrichCandidatesWithMarketData(
  candidates: TokenCandidate[],
  marketData: Map<string, CoinGeckoMarketData>,
): void {
  for (const candidate of candidates) {
    const cg = marketData.get(candidate.symbol);
    if (!cg) continue;

    // If LLM emits an implausible price (e.g. raw quote ratio in ETH terms),
    // prefer CoinGecko USD price for stable, user-facing output.
    const candidatePrice = candidate.priceUSD ?? 0;
    const cgPrice = cg.price_usd ?? 0;
    const priceRatio =
      candidatePrice > 0 && cgPrice > 0 ? candidatePrice / cgPrice : 0;
    const isPriceOutlier =
      priceRatio > 0 && (priceRatio < 0.2 || priceRatio > 5);
    if (
      !candidate.priceUSD ||
      candidate.priceUSD <= 0 ||
      candidate.priceUSD < 0.001 ||
      isPriceOutlier
    ) {
      candidate.priceUSD = cg.price_usd;
    }

    if (!candidate.volume24hUSD || candidate.volume24hUSD === 0) {
      candidate.volume24hUSD = cg.volume_24h_usd;
    }
    if (!candidate.priceChange24hPct || candidate.priceChange24hPct === 0) {
      candidate.priceChange24hPct = cg.price_change_24h_pct;
    }
  }
}

export function filterCandidatesByLiquidity(
  candidates: TokenCandidate[],
  minLiquidityUSD: number,
): TokenCandidate[] {
  return (
    candidates
      .filter((c) => c.liquidityUSD >= minLiquidityUSD)
      // Drop any stablecoin the LLM tried to slip through. The trade always
      // starts FROM USDC, so a stable tokenOut is a 1:1 swap with no upside.
      .filter((c) => !isStablecoin({ symbol: c.symbol, address: c.address }))
  );
}
