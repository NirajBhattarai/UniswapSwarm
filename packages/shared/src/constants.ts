// Uniswap Trading API (hosted, auth via x-api-key header)
export const UNISWAP_TRADE_API_BASE_URL =
  "https://trade-api.gateway.uniswap.org/v1";

// Uniswap V3 Ethereum Mainnet addresses
export const UNISWAP = {
  SWAP_ROUTER_02: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
  QUOTER_V2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
  FACTORY: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
} as const;

export const TOKENS = {
  WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  USDT: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  WBTC: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
  DAI: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
} as const;

export const POOL_FEE_TIERS = [500, 3000, 10_000] as const;
export type PoolFeeTier = (typeof POOL_FEE_TIERS)[number];

// Uniswap V3 subgraph (hosted service — free, no API key needed)
export const UNISWAP_SUBGRAPH_URL =
  "https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v3";

// Minimum sanity values
export const DEFAULTS = {
  MIN_LIQUIDITY_USD: 100_000,
  MAX_SLIPPAGE_PCT: 1.5,
  MAX_POSITION_USDC: 50,
  RISK_SCORE_PASS_THRESHOLD: 65,
} as const;
