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
// Symbols and Ethereum mainnet addresses for USD-pegged stablecoins.
// Used by the Strategy/Critic agents to forbid stable→stable swaps (USDC→USDT,
// DAI→USDC, etc.) which are economically meaningless 1:1 trades and should
// never appear as proposed "safe trades".

export const STABLECOIN_SYMBOLS: ReadonlySet<string> = new Set([
  "USDC",
  "USDT",
  "DAI",
  "BUSD",
  "FRAX",
  "TUSD",
  "USDP",
  "USDD",
  "GUSD",
  "LUSD",
  "USDE", // Ethena
  "FDUSD", // First Digital USD
  "PYUSD", // PayPal USD
  "USDS", // Sky / former MakerDAO
  "CRVUSD",
]);

export const STABLECOIN_ADDRESSES: ReadonlySet<string> = new Set(
  [
    "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC
    "0xdAC17F958D2ee523a2206206994597C13D831ec7", // USDT
    "0x6B175474E89094C44Da98b954EedeAC495271d0F", // DAI
    "0x4Fabb145d64652a948d72533023f6E7A623C7C53", // BUSD
    "0x853d955aCEf822Db058eb8505911ED77F175b99e", // FRAX
    "0x0000000000085d4780B73119b644AE5ecd22b376", // TUSD
    "0x8E870D67F660D95d5be530380D0eC0bd388289E1", // USDP (Pax Dollar)
    "0x056Fd409E1d7A124BD7017459dFEa2F387b6d5Cd", // GUSD
    "0x0fA8781a83E46826621b3BC094Ea2A0212e71B23", // USDD
    "0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409", // FDUSD
    "0x6c3ea9036406852006290770BEdFcAbA0e23A0e8", // PYUSD
    "0x4c9EDD5852cd905f086C759E8383e09bff1E68B3", // USDe
    "0xdC035D45d973E3EC169d2276DDab16f1e407384F", // USDS
    "0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E", // crvUSD
    "0x5f98805A4E8be255a32880FDeC7F6728C6568bA0", // LUSD
  ].map((a) => a.toLowerCase()),
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
