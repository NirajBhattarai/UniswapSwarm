// Uniswap Trading API (hosted, auth via x-api-key header)
export const UNISWAP_TRADE_API_BASE_URL =
  "https://trade-api.gateway.uniswap.org/v1";

// CoinGecko API (free demo tier + pro tier — both use the same base URL with different key headers)
export const COINGECKO_API_BASE_URL = "https://api.coingecko.com/api/v3";

export const TOKENS = {
  WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  USDT: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  WBTC: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
  DAI: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
} as const;

// Zero address — used to represent native ETH and anonymous/unset wallets
export const ZERO_ADDRESS =
  "0x0000000000000000000000000000000000000000" as const;

// Minimum sanity values
export const DEFAULTS = {
  MIN_LIQUIDITY_USD: 100_000,
  MAX_SLIPPAGE_PCT: 1.5,
  MAX_POSITION_USDC: 50,
  RISK_SCORE_PASS_THRESHOLD: 65,
} as const;

// ─── Stablecoins ───────────────────────────────────────────────────────────────
// Single source of truth: Ethereum mainnet USD stablecoins used by Strategy/Risk
// (forbid stable→stable swaps) and by Researcher pool resolution.

export const ETHEREUM_MAINNET_STABLECOIN_DEFS = [
  {
    symbol: "USDC",
    address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    decimals: 6,
  },
  {
    symbol: "USDT",
    address: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    decimals: 6,
  },
  {
    symbol: "DAI",
    address: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
    decimals: 18,
  },
  {
    symbol: "BUSD",
    address: "0x4Fabb145d64652a948d72533023f6E7A623C7C53",
    decimals: 18,
  },
  {
    symbol: "FRAX",
    address: "0x853d955aCEf822Db058eb8505911ED77F175b99e",
    decimals: 18,
  },
  {
    symbol: "TUSD",
    address: "0x0000000000085d4780B73119b644AE5ecd22b376",
    decimals: 18,
  },
  {
    symbol: "USDP",
    address: "0x8E870D67F660D95d5be530380D0eC0bd388289E1",
    decimals: 18,
  },
  {
    symbol: "GUSD",
    address: "0x056Fd409E1d7A124BD7017459dFEa2F387b6d5Cd",
    decimals: 2,
  },
  {
    symbol: "USDD",
    address: "0x0FA8781a83E46826621b3BC094Ea2A0212e71B23",
    decimals: 18,
  },
  {
    symbol: "FDUSD",
    address: "0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409",
    decimals: 18,
  },
  {
    symbol: "PYUSD",
    address: "0x6c3ea9036406852006290770BEdFcAbA0e23A0e8",
    decimals: 6,
  },
  {
    symbol: "USDE",
    address: "0x4c9EDD5852cd905f086C759E8383e09bff1E68B3",
    decimals: 18,
  },
  {
    symbol: "USDS",
    address: "0xdC035D45d973E3EC169d2276DDab16f1e407384F",
    decimals: 18,
  },
  {
    symbol: "CRVUSD",
    address: "0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E",
    decimals: 18,
  },
  {
    symbol: "LUSD",
    address: "0x5f98805A4E8be255a32880FDeC7F6728C6568bA0",
    decimals: 18,
  },
] as const;

export const STABLECOIN_SYMBOLS: ReadonlySet<string> = new Set(
  ETHEREUM_MAINNET_STABLECOIN_DEFS.map((t) => t.symbol),
);

export const STABLECOIN_ADDRESSES: ReadonlySet<string> = new Set(
  ETHEREUM_MAINNET_STABLECOIN_DEFS.map((t) => t.address.toLowerCase()),
);

/**
 * Returns true when a token (resolved by either symbol or on-chain address)
 * is a USD-pegged stablecoin we want to exclude from non-trivial trades.
 */
export function isStablecoinSymbol(symbol?: string): boolean {
  if (!symbol) return false;
  return STABLECOIN_SYMBOLS.has(symbol.toUpperCase());
}

export function isStablecoinAddress(address?: string): boolean {
  if (!address) return false;
  return STABLECOIN_ADDRESSES.has(address.toLowerCase());
}

export function isStablecoin(token: {
  symbol?: string;
  address?: string;
}): boolean {
  return isStablecoinSymbol(token.symbol) || isStablecoinAddress(token.address);
}

/** Registry entry for Researcher / Trading API quote resolution (Ethereum mainnet). */
export type EthereumMainnetTokenRegistryEntry = {
  address: string;
  decimals: number;
  isStablecoin?: boolean;
};

const _WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";

/** Full symbol → contract map for @swarm/agent-researcher (no hardcoding in the agent). */
export const ETHEREUM_MAINNET_RESEARCHER_TOKEN_REGISTRY: Record<
  string,
  EthereumMainnetTokenRegistryEntry
> = {
  ETH: { address: _WETH, decimals: 18 },
  WETH: { address: _WETH, decimals: 18 },
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
  GRT: { address: "0xc944E90C64B2c07662A292be6244BDf05Cda44a7", decimals: 18 },
  // ── L2 tokens ──────────────────────────────────────────────────────────────
  ARB: { address: "0xB50721BCf8d664c30412Cfbc6cf7a15145234ad1", decimals: 18 },
  MATIC: {
    address: "0x7D1AfA7B718fb893dB30A3aBc0Cfc608AaCfeBB0",
    decimals: 18,
  },
  OP: { address: "0x4200000000000000000000000000000000000042", decimals: 18 },
  POL: { address: "0x455e53CBB86018Ac2B8092FdCd39d8444aFFC3F6", decimals: 18 },
  IMX: { address: "0xF57e7e7C23978C3cAEC3C3548E3D615c346e79fF", decimals: 18 },
  METIS: {
    address: "0x9E32b13ce7f2E80A01932B42553652E053D6ed8e",
    decimals: 18,
  },
  BOBA: { address: "0x42bBFa2e77757C645eeaAd1655E0911a7553Efbc", decimals: 18 },
  STRK: { address: "0xCa14007Eff0dB1f8135f4C25B34De49AB0d42766", decimals: 18 },
  MANTA: {
    address: "0xa7ba16B12A5b068CB0Af480db33Ee68D13819AFA",
    decimals: 18,
  },
  ZKS: { address: "0x66A5cFB2e9c529f14FE6364Ad1075dF3a649C0A5", decimals: 18 },
  // ── Staking / liquid staking ────────────────────────────────────────────────
  LDO: { address: "0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32", decimals: 18 },
  RPL: { address: "0xD33526068D116cE69F19A9ee46F0bd304F21A51f", decimals: 18 },
  // ── AI / artificial intelligence tokens ────────────────────────────────────
  FET: { address: "0xaea46A60368A7bD060eec7DF8CBa43b7EF41Ad85", decimals: 18 },
  RNDR: { address: "0x6De037ef9aD2725EB40118Bb1702EBb27e4Aeb24", decimals: 18 },
  OCEAN: {
    address: "0x967da4048cD07aB37855c090aAF366e4ce1b9F48",
    decimals: 18,
  },
  AGIX: { address: "0x5B7533812759B45C2B44C19e320ba2cD2681b542", decimals: 8 },
  AIOZ: { address: "0x626E8036dEB333b408Be468F951bdB42433cBF18", decimals: 18 },
  AKT: { address: "0xEAdab23B4F4Af7f3bbc0b43c6b9A48dd5F3f9B36", decimals: 6 },
  TAO: { address: "0x77E06c9eCCf2E797fd462A92B6D7642EF85b0A44", decimals: 9 },
};

export const USDC_DEF: EthereumMainnetTokenRegistryEntry =
  ETHEREUM_MAINNET_RESEARCHER_TOKEN_REGISTRY["USDC"]!;
export const WETH_DEF: EthereumMainnetTokenRegistryEntry =
  ETHEREUM_MAINNET_RESEARCHER_TOKEN_REGISTRY["WETH"]!;

// ─── ENS ──────────────────────────────────────────────────────────────────────

/** Root ENS name owned by the project. */
export const ENS_ROOT = "uniswapswarm.eth" as const;

/** Per-agent ENS subdomains. */
export const AGENT_ENS_NAMES = {
  researcher: "researcher.uniswapswarm.eth",
  planner: "planner.uniswapswarm.eth",
  risk: "risk.uniswapswarm.eth",
  strategy: "strategy.uniswapswarm.eth",
  critic: "critic.uniswapswarm.eth",
  executor: "executor.uniswapswarm.eth",
} as const;

export type AgentEnsName =
  (typeof AGENT_ENS_NAMES)[keyof typeof AGENT_ENS_NAMES];

/** ENS contract addresses per network. */
export const ENS_CONTRACTS_BY_CHAIN = {
  /** Ethereum mainnet (chainId 1) */
  1: {
    registry: "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e",
    nameWrapper: "0xD4416b13d2b3a9aBae7AcD5D6C2BbDBE25686401",
    publicResolver: "0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63",
  },
  /** Sepolia testnet (chainId 11155111) */
  11155111: {
    registry: "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e",
    nameWrapper: "0x0635513f179D50A207757E05759CbD106d7dFcE8",
    publicResolver: "0x8FADE66B79cC9f707aB26799354482EB93a5B7dD",
  },
} as const;

/** @deprecated Use ENS_CONTRACTS_BY_CHAIN[1] for mainnet. Kept for backwards-compat. */
export const ENS_CONTRACTS = ENS_CONTRACTS_BY_CHAIN[1];
