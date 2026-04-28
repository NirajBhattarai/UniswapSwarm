import type { TokenDef, QueryPair, NarrativeType } from "./types";

// ─── Minimal concentrated-liquidity pool ABI ─────────────────────────────────

export const POOL_ABI = [
  "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)",
  "function liquidity() external view returns (uint128)",
];

// ─── Uniswap QuoterV2 ABI (quoteExactInputSingle) ────────────────────────────

export const QUOTER_V2_ABI = [
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
];

// ─── Uniswap pool factory ABI ────────────────────────────────────────────────

export const FACTORY_ABI = [
  "function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)",
];

// ─── Minimal ERC-20 ABI (for resolving unknown addresses) ────────────────────

export const ERC20_META_ABI = [
  "function symbol() external view returns (string)",
  "function decimals() external view returns (uint8)",
];

// ─── Multicall3 — batch ALL balance reads in a single eth_call ────────────────
// Deployed on Ethereum mainnet (and 250+ other chains) at the canonical address.
// getEthBalance fetches native ETH balance without a separate eth_getBalance call.
// aggregate3 executes all calls atomically — every result is from the same block.
export const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11";

export const MULTICALL3_ABI = [
  "function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) view returns (tuple(bool success, bytes returnData)[] returnData)",
  "function getEthBalance(address addr) view returns (uint256 balance)",
];

// ABI fragment used only for encoding balanceOf calldata into Multicall3 calls.
export const ERC20_BALANCE_IFACE_ABI = [
  "function balanceOf(address owner) external view returns (uint256)",
];

// ─── Canonical token registry (Ethereum mainnet) ─────────────────────────────
// ETH is treated as WETH for quoting purposes.

export const SYMBOL_TO_TOKEN: Record<string, TokenDef> = {
  ETH: { address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", decimals: 18 },
  WETH: { address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", decimals: 18 },
  USDC: {
    address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    decimals: 6,
    isStablecoin: true,
  },
  USDT: {
    address: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    decimals: 6,
    isStablecoin: true,
  },
  DAI: {
    address: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
    decimals: 18,
    isStablecoin: true,
  },
  WBTC: { address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", decimals: 8 },
  LINK: { address: "0x514910771AF9Ca656af840dff83E8264EcF986CA", decimals: 18 },
  UNI: { address: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984", decimals: 18 },
  AAVE: { address: "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9", decimals: 18 },
  MKR: { address: "0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2", decimals: 18 },
  CRV: { address: "0xD533a949740bb3306d119CC777fa900bA034cd52", decimals: 18 },
  // Narrative extra tokens (ai / l2 / staking narratives)
  GRT: { address: "0xc944E90C64B2c07662A292be6244BDf05Cda44a7", decimals: 18 },
  ARB: { address: "0xB50721BCf8d664c30412Cfbc6cf7a15145234ad1", decimals: 18 },
  MATIC: {
    address: "0x7D1AfA7B718fb893dB30A3aBc0Cfc608AaCfeBB0",
    decimals: 18,
  },
  LDO: { address: "0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32", decimals: 18 },
  RPL: { address: "0xD33526068D116cE69F19A9ee46F0bd304F21A51f", decimals: 18 },
  FET: { address: "0xaea46A60368A7bD060eec7DF8CBa43b7EF41Ad85", decimals: 18 },
  RNDR: { address: "0x6De037ef9aD2725EB40118Bb1702EBb27e4Aeb24", decimals: 18 },
};

// Reverse lookup: address (lower-case) → symbol
export const ADDRESS_TO_SYMBOL: Record<string, string> = Object.fromEntries(
  Object.entries(SYMBOL_TO_TOKEN).map(([sym, def]) => [
    def.address.toLowerCase(),
    sym,
  ]),
);

// Explicit consts ensure non-undefined types even with noUncheckedIndexedAccess
export const USDC_DEF: TokenDef = {
  address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  decimals: 6,
  isStablecoin: true,
};

export const WETH_DEF: TokenDef = {
  address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  decimals: 18,
};

export const FEE_TIERS = [500, 3000, 10_000] as const;

export const MIN_POOL_LIQUIDITY_USD = 10_000;

/** Placeholder EOA used as swapper for quote-only calls — not executing any swap */
export const QUOTE_SWAPPER_ADDRESS =
  "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

// ─── Token pairs to quote via Uniswap Trading API ────────────────────────────

export const QUERY_PAIRS: QueryPair[] = [
  {
    tokenIn: {
      address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      symbol: "WETH",
      name: "Wrapped Ether",
      decimals: 18,
    },
    tokenOut: {
      address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      symbol: "USDC",
      name: "USD Coin",
      decimals: 6,
    },
    amountIn: "1000000000000000000", // 1 WETH
    priceLabel: "USDC per WETH",
  },
  {
    tokenIn: {
      address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      symbol: "WETH",
      name: "Wrapped Ether",
      decimals: 18,
    },
    tokenOut: {
      address: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      symbol: "USDT",
      name: "Tether USD",
      decimals: 6,
    },
    amountIn: "1000000000000000000", // 1 WETH
    priceLabel: "USDT per WETH",
  },
  {
    tokenIn: {
      address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
      symbol: "WBTC",
      name: "Wrapped Bitcoin",
      decimals: 8,
    },
    tokenOut: {
      address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      symbol: "WETH",
      name: "Wrapped Ether",
      decimals: 18,
    },
    amountIn: "10000000", // 0.1 WBTC
    priceLabel: "WETH per WBTC",
  },
  {
    tokenIn: {
      address: "0x514910771AF9Ca656af840dff83E8264EcF986CA",
      symbol: "LINK",
      name: "Chainlink",
      decimals: 18,
    },
    tokenOut: {
      address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      symbol: "WETH",
      name: "Wrapped Ether",
      decimals: 18,
    },
    amountIn: "10000000000000000000", // 10 LINK
    priceLabel: "WETH per LINK",
  },
  {
    tokenIn: {
      address: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984",
      symbol: "UNI",
      name: "Uniswap",
      decimals: 18,
    },
    tokenOut: {
      address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      symbol: "WETH",
      name: "Wrapped Ether",
      decimals: 18,
    },
    amountIn: "10000000000000000000", // 10 UNI
    priceLabel: "WETH per UNI",
  },
  {
    tokenIn: {
      address: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
      symbol: "DAI",
      name: "Dai Stablecoin",
      decimals: 18,
    },
    tokenOut: {
      address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      symbol: "USDC",
      name: "USD Coin",
      decimals: 6,
    },
    amountIn: "100000000000000000000", // 100 DAI
    priceLabel: "USDC per DAI",
  },
];

// ─── CoinGecko ID map (symbol → CoinGecko coin id) ───────────────────────────

export const SYMBOL_TO_COINGECKO_ID: Record<string, string> = {
  ETH: "ethereum",
  WETH: "ethereum",
  BTC: "bitcoin",
  WBTC: "wrapped-bitcoin",
  USDC: "usd-coin",
  USDT: "tether",
  DAI: "dai",
  LINK: "chainlink",
  UNI: "uniswap",
  AAVE: "aave",
  MKR: "maker",
  CRV: "curve-dao-token",
  FET: "fetch-ai",
  RNDR: "render-token",
  GRT: "the-graph",
  ARB: "arbitrum",
  OP: "optimism",
  MATIC: "matic-network",
  LDO: "lido-dao",
  RPL: "rocket-pool",
};

// ─── Narrative keyword detection ──────────────────────────────────────────────

export const NARRATIVE_KEYWORDS: Record<NarrativeType, string[]> = {
  ai: [
    "ai token",
    "ai coin",
    "ai crypto",
    "artificial intelligence",
    "machine learning",
    "chatgpt",
    "gpt",
    "llm",
    "fetch.ai",
    "render network",
    "the graph",
    "ai agent",
    "neural network",
    "rndr",
    "fet",
  ],
  safe_haven: [
    "war",
    "conflict",
    "hack",
    "exploit",
    "crash",
    "ban",
    "sanction",
    "fear",
    "recession",
    "panic",
    "collapse",
    "rug",
  ],
  defi: [
    "defi",
    "yield",
    "liquidity",
    "amm",
    "lending",
    "borrow",
    "vault",
    "aave",
    "curve",
    "maker",
    "protocol",
  ],
  l2: [
    "layer 2",
    "l2",
    "arbitrum",
    "optimism",
    "polygon",
    "scaling",
    "rollup",
    "zk",
    "base",
  ],
  staking: [
    "staking",
    "stake",
    "validator",
    "lido",
    "rocket pool",
    "liquid staking",
    "restaking",
    "eigenlayer",
  ],
  neutral: [],
};

// Top tokens to fetch market data for under each narrative
export const NARRATIVE_EXTRA_SYMBOLS: Record<NarrativeType, string[]> = {
  ai: ["FET", "RNDR", "GRT", "LINK"],
  safe_haven: ["WBTC", "ETH"],
  defi: ["AAVE", "CRV", "UNI", "MKR"],
  l2: ["ARB", "OP", "MATIC"],
  staking: ["LDO", "RPL"],
  neutral: [],
};
