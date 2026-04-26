// ─── Uniswap Trading API response types ──────────────────────────────────────

export interface UniswapAPIRoutePool {
  // "v2-pool" | "v3-pool" | "v4-pool" | "mixed-route"
  type: string;
  address: string;
  tokenIn: {
    address: string;
    chainId: number;
    decimals: string;
    symbol: string;
  };
  tokenOut: {
    address: string;
    chainId: number;
    decimals: string;
    symbol: string;
  };
  fee: string;
  // V3/V4 only — absent on V2 pools
  sqrtRatioX96?: string;
  liquidity?: string;
  tick?: number;
  amountIn?: string;
  amountOut?: string;
}

export interface UniswapAPIQuoteResponse {
  routing?: string;
  quote?: {
    chainId: number;
    input: {
      token: { address: string; decimals: number; symbol: string };
      amount: string;
    };
    output: {
      token: { address: string; decimals: number; symbol: string };
      amount: string;
    };
    /**
     * `route` is only populated for CLASSIC routings (V2/V3/V4). UNISWAPX
     * variants (`DUTCH_LIMIT`, `DUTCH_V2`, `DUTCH_V3`) omit it entirely.
     */
    route?: UniswapAPIRoutePool[][];
  };
  errorCode?: string;
  detail?: string;
}

// ─── Token registry entry ─────────────────────────────────────────────────────

export interface TokenDef {
  address: string;
  decimals: number;
  isStablecoin?: boolean;
}

// ─── Token pairs to query via Uniswap Trading API ────────────────────────────

export interface QueryPair {
  tokenIn: { address: string; symbol: string; name: string; decimals: number };
  tokenOut: { address: string; symbol: string; name: string; decimals: number };
  /** Amount of tokenIn in smallest units (wei) */
  amountIn: string;
  priceLabel: string;
}

// ─── On-chain pool snapshot ────────────────────────────────────────────────────

export interface PoolSnapshot {
  /** The pool contract address */
  poolAddress: string;
  /** The ERC-20 token address to trade (non-WETH / non-stablecoin leg of the pair).
   *  Pre-computed — use this directly as the candidate `address` field. */
  tokenAddress: string;
  tokenSymbol: string;
  tokenName: string;
  /** The base token on the other side (WETH / USDC / USDT / DAI) */
  baseTokenSymbol: string;
  baseTokenAddress: string;
  /** Protocol that produced this quote (v2-pool | v3-pool | v4-pool) */
  protocol: string;
  feePct: number;
  priceLabel: string;
  /** tokenAddress price expressed in USD */
  currentPrice: number;
  virtualToken1: number;
  liquidityUSD: number;
  liquidityRaw: string;
  tick: number;
}

// ─── Narrative detection ──────────────────────────────────────────────────────

export type NarrativeType =
  | "ai" // AI / ML coins: FET, RNDR, GRT, LINK
  | "safe_haven" // Macro fear / war / hack → BTC, ETH
  | "defi" // DeFi season → AAVE, CRV, UNI, MKR
  | "l2" // L2 scaling → ARB, OP, MATIC
  | "staking" // ETH staking → LDO, RPL
  | "neutral"; // No clear signal — use default pairs

export interface NarrativeSignal {
  narrative: NarrativeType;
  score: number; // 0–100 relative strength of the detected narrative
  topHeadlines: string[]; // up to 5 matching headlines
  trendingTokens: string[]; // CoinGecko top-7 trending symbols right now
  fearGreedValue: number; // 0–100 (0=Extreme Fear, 100=Extreme Greed)
  fearGreedLabel: string; // e.g. "Fear", "Greed"
  extraSymbols: string[]; // symbols to additionally fetch market data for
}

// ─── CoinGecko market data ────────────────────────────────────────────────────

export interface CoinGeckoMarketData {
  symbol: string;
  price_usd: number;
  volume_24h_usd: number;
  price_change_24h_pct: number;
  market_cap_usd: number;
}

// ─── Price-fetching public contract ──────────────────────────────────────────

export interface TokenPriceResult {
  /** Original symbol or checksummed address as provided by the caller */
  symbol: string;
  /** Resolved Ethereum mainnet ERC-20 address (42-char hex) */
  address: string;
  /** USD price derived from on-chain Uniswap data; null if unresolvable */
  price_usd: number | null;
  source: "uniswap";
  /** Pair route used: "TOKEN/USDC" | "TOKEN/WETH" | "NONE" */
  liquidity_used: string;
  /** 24h trading volume in USD across all exchanges (CoinGecko) */
  volume_24h_usd?: number | null;
  /** 24h price change percentage (CoinGecko) */
  price_change_24h_pct?: number | null;
  /** Market capitalisation in USD (CoinGecko) */
  market_cap_usd?: number | null;
}

export interface PriceQuoteResponse {
  data: TokenPriceResult[];
}
