import {
  ETHEREUM_MAINNET_RESEARCHER_TOKEN_REGISTRY,
  USDC_DEF as SHARED_USDC_DEF,
  WETH_DEF as SHARED_WETH_DEF,
} from "@swarm/shared";
import type { TokenDef, QueryPair, NarrativeType } from "./types";

// ─── Minimal ERC-20 ABI (for resolving unknown addresses) ────────────────────

export const ERC20_META_ABI = [
  "function symbol() external view returns (string)",
  "function decimals() external view returns (uint8)",
];

// ─── Canonical token registry (Ethereum mainnet) ─────────────────────────────
// Sourced from @swarm/shared — ETH is treated as WETH for quoting purposes.

export const SYMBOL_TO_TOKEN: Record<string, TokenDef> =
  ETHEREUM_MAINNET_RESEARCHER_TOKEN_REGISTRY as Record<string, TokenDef>;

// Reverse lookup: address (lower-case) → symbol
export const ADDRESS_TO_SYMBOL: Record<string, string> = Object.fromEntries(
  Object.entries(SYMBOL_TO_TOKEN).map(([sym, def]) => [
    def.address.toLowerCase(),
    sym,
  ]),
);

export const USDC_DEF: TokenDef = SHARED_USDC_DEF as TokenDef;
export const WETH_DEF: TokenDef = SHARED_WETH_DEF as TokenDef;

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
