import {
  STABLECOIN_SYMBOLS,
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

type GoalCategory = "L1" | "L2" | "DeFi" | "RWA" | "AI" | "Stable";

const GOAL_CATEGORY_KEYWORDS: Array<{
  category: GoalCategory;
  patterns: string[];
}> = [
  {
    category: "DeFi",
    patterns: [
      "defi",
      "dex",
      "amm",
      "yield",
      "lending",
      "borrow",
      "perp",
      "derivatives",
      "liquid staking",
    ],
  },
  {
    category: "AI",
    patterns: [
      " ai ",
      "ai token",
      "ai coin",
      "artificial intelligence",
      "machine learning",
      "agentic",
      "llm",
      "gpt",
      "render",
      "fetch",
    ],
  },
  {
    category: "L2",
    patterns: [
      "layer 2",
      "layer2",
      " l2 ",
      "rollup",
      "arbitrum",
      "optimism",
      "polygon",
      "starknet",
      "zksync",
      "base",
    ],
  },
  {
    category: "L1",
    patterns: [
      "layer 1",
      "layer1",
      " l1 ",
      "base layer",
      "store of value",
      "bitcoin",
      "ethereum",
      "solana",
    ],
  },
  {
    category: "RWA",
    patterns: [
      "rwa",
      "real world asset",
      "real-world asset",
      "treasury",
      "tokenized bond",
      "gold-backed",
      "tokenized gold",
    ],
  },
  {
    category: "Stable",
    patterns: ["stablecoin", "stable coin", "usd pegged", "usd-pegged"],
  },
];

const CATEGORY_SYMBOLS: Record<Exclude<GoalCategory, "Stable">, Set<string>> = {
  L1: new Set(["ETH", "WETH", "WBTC"]),
  L2: new Set([
    "ARB",
    "OP",
    "MATIC",
    "POL",
    "IMX",
    "METIS",
    "BOBA",
    "STRK",
    "MANTA",
    "ZKS",
  ]),
  DeFi: new Set(["UNI", "AAVE", "MKR", "CRV", "LINK", "LDO", "RPL"]),
  RWA: new Set(["ONDO", "PAXG", "XAUT", "MPLX", "CFG"]),
  AI: new Set(["FET", "RNDR", "OCEAN", "AGIX", "AIOZ", "AKT", "TAO", "GRT"]),
};

function detectGoalCategory(goal: string): GoalCategory | null {
  const normalized = ` ${goal.toLowerCase()} `;
  for (const { category, patterns } of GOAL_CATEGORY_KEYWORDS) {
    if (patterns.some((pattern) => normalized.includes(pattern))) {
      return category;
    }
  }
  return null;
}

function applyGoalCategoryFocus(
  pools: PoolSnapshot[],
  goalCategory: GoalCategory | null,
): PoolSnapshot[] {
  const sorted = [...pools].sort((a, b) => b.liquidityUSD - a.liquidityUSD);
  if (!goalCategory) return sorted;

  if (goalCategory === "Stable") {
    // Stable token-out candidates are blocked by strategy/risk rules.
    return sorted.filter((p) => !STABLECOIN_SYMBOLS.has(p.tokenSymbol));
  }

  const symbolSet = CATEGORY_SYMBOLS[goalCategory];
  const focused = sorted.filter((p) => symbolSet.has(p.tokenSymbol));
  if (focused.length === 0) return sorted;
  if (focused.length >= 5) return focused;

  const focusedSymbols = new Set(focused.map((p) => p.tokenSymbol));
  const fallback = sorted.filter((p) => !focusedSymbols.has(p.tokenSymbol));
  return [...focused, ...fallback.slice(0, Math.max(0, 10 - focused.length))];
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

  const goalCategory = detectGoalCategory(goal);
  const focusedPools = applyGoalCategoryFocus(pools, goalCategory);

  // Send all qualifying pools sorted by liquidityUSD descending so the LLM can
  // evaluate the full opportunity set. No arbitrary row cap — deeper context
  // allows the model to surface more unique non-stablecoin candidates.
  const compactPools = focusedPools.map((p) => ({
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
    goalCategory
      ? `Goal category hint: ${goalCategory} (token feed has been pre-focused toward this category before ranking)`
      : null,
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
