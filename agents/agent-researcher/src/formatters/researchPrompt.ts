import { isStablecoin, type TokenCandidate } from "@swarm/shared";

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
}

export function buildMarketDataText(
  marketData: Map<string, CoinGeckoMarketData>,
): string {
  if (marketData.size === 0) return "";

  const lines = Array.from(marketData.entries()).map(
    ([sym, d]) =>
      `${sym}: price=$${(d.price_usd ?? 0).toFixed(4)} vol24h=$${((d.volume_24h_usd ?? 0) / 1e6).toFixed(1)}M chg24h=${(d.price_change_24h_pct ?? 0).toFixed(2)}% mcap=$${((d.market_cap_usd ?? 0) / 1e9).toFixed(2)}B`,
  );
  return `\nLive CoinGecko market data (24h):\n${lines.join("\n")}`;
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
  const { goal, cfg, pools, marketDataText, narrativeText, context } = args;

  return [
    `Trading goal: ${goal}`,
    `Default constraints: maxSlippage=${cfg.MAX_SLIPPAGE_PCT}%, maxPosition=$${cfg.MAX_POSITION_USDC} USDC, minLiquidity=$${cfg.MIN_LIQUIDITY_USD.toLocaleString()}`,
    `Live Uniswap multi-protocol pool data (V2/V3/V4/UniswapX) - each entry has a pre-computed \`tokenAddress\` - use it directly as the candidate \`address\` field:\n${JSON.stringify(pools, null, 2)}`,
    marketDataText,
    `\nReal-time narrative signal:\n${narrativeText}`,
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
