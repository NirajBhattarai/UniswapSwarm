import { ZGCompute, type InferOptions } from "@swarm/compute";
import { BlackboardMemory } from "@swarm/memory";
import {
  logger,
  getConfig,
  UNISWAP,
  UNISWAP_TRADE_API_BASE_URL,
  COINGECKO_API_BASE_URL,
} from "@swarm/shared";
import type { ResearchReport, TokenCandidate } from "@swarm/shared";
import { ethers } from "ethers";

// ─── Minimal Uniswap V3 Pool ABI ──────────────────────────────────────────────

const POOL_ABI = [
  "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)",
  "function liquidity() external view returns (uint128)",
];

// ─── Uniswap V3 QuoterV2 ABI (quoteExactInputSingle) ─────────────────────────
// quoteExactInputSingle is NOT a view — use .staticCall() to simulate it.

const QUOTER_V2_ABI = [
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
];

// ─── Uniswap V3 Factory ABI ────────────────────────────────────────────────────

const FACTORY_ABI = [
  "function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)",
];

// ─── Minimal ERC-20 ABI (for resolving unknown addresses) ─────────────────────

const ERC20_META_ABI = [
  "function symbol() external view returns (string)",
  "function decimals() external view returns (uint8)",
];

// ─── Canonical token registry (Ethereum mainnet) ──────────────────────────────
// ETH is treated as WETH for quoting purposes.

interface TokenDef {
  address: string;
  decimals: number;
  isStablecoin?: boolean;
}

const SYMBOL_TO_TOKEN: Record<string, TokenDef> = {
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
};

// Reverse lookup: address (lower-case) → symbol
const ADDRESS_TO_SYMBOL: Record<string, string> = Object.fromEntries(
  Object.entries(SYMBOL_TO_TOKEN).map(([sym, def]) => [
    def.address.toLowerCase(),
    sym,
  ]),
);

// These are defined as explicit consts (not indexed from the map) to guarantee
// non-undefined types even when noUncheckedIndexedAccess is enabled.
const USDC_DEF: TokenDef = {
  address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  decimals: 6,
  isStablecoin: true,
};
const WETH_DEF: TokenDef = {
  address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  decimals: 18,
};
const FEE_TIERS = [500, 3000, 10_000] as const;
const MIN_POOL_LIQUIDITY_USD = 10_000; // skip pools with less than $10k virtual liquidity

// ─── Uniswap Trading API response types ──────────────────────────────────────

interface UniswapAPIRoutePool {
  type: string;
  address: string;
  tokenIn: { address: string; chainId: number; decimals: string; symbol: string };
  tokenOut: { address: string; chainId: number; decimals: string; symbol: string };
  fee: string;
  sqrtRatioX96: string;
  liquidity: string;
  tick: number;
  amountIn?: string;
  amountOut?: string;
}

interface UniswapAPIQuoteResponse {
  routing?: string;
  quote?: {
    chainId: number;
    input: { token: { address: string; decimals: number; symbol: string }; amount: string };
    output: { token: { address: string; decimals: number; symbol: string }; amount: string };
    route: UniswapAPIRoutePool[][];
  };
  errorCode?: string;
  detail?: string;
}

// ─── Token pairs to quote via Uniswap Trading API ────────────────────────────

interface QueryPair {
  tokenIn: { address: string; symbol: string; name: string; decimals: number };
  tokenOut: { address: string; symbol: string; name: string; decimals: number };
  /** Amount of tokenIn in smallest units (wei) */
  amountIn: string;
  priceLabel: string;
}

/** Placeholder EOA used as swapper for quote-only calls — not executing any swap */
const QUOTE_SWAPPER_ADDRESS = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

const QUERY_PAIRS: QueryPair[] = [
  {
    tokenIn:  { address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", symbol: "WETH",  name: "Wrapped Ether",   decimals: 18 },
    tokenOut: { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", symbol: "USDC",  name: "USD Coin",        decimals: 6  },
    amountIn: "1000000000000000000", // 1 WETH
    priceLabel: "USDC per WETH",
  },
  {
    tokenIn:  { address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", symbol: "WETH",  name: "Wrapped Ether",   decimals: 18 },
    tokenOut: { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", symbol: "USDT",  name: "Tether USD",       decimals: 6  },
    amountIn: "1000000000000000000", // 1 WETH
    priceLabel: "USDT per WETH",
  },
  {
    tokenIn:  { address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", symbol: "WBTC",  name: "Wrapped Bitcoin",  decimals: 8  },
    tokenOut: { address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", symbol: "WETH",  name: "Wrapped Ether",   decimals: 18 },
    amountIn: "10000000", // 0.1 WBTC
    priceLabel: "WETH per WBTC",
  },
  {
    tokenIn:  { address: "0x514910771AF9Ca656af840dff83E8264EcF986CA", symbol: "LINK",  name: "Chainlink",        decimals: 18 },
    tokenOut: { address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", symbol: "WETH",  name: "Wrapped Ether",   decimals: 18 },
    amountIn: "10000000000000000000", // 10 LINK
    priceLabel: "WETH per LINK",
  },
  {
    tokenIn:  { address: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984", symbol: "UNI",   name: "Uniswap",          decimals: 18 },
    tokenOut: { address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", symbol: "WETH",  name: "Wrapped Ether",   decimals: 18 },
    amountIn: "10000000000000000000", // 10 UNI
    priceLabel: "WETH per UNI",
  },
  {
    tokenIn:  { address: "0x6B175474E89094C44Da98b954EedeAC495271d0F", symbol: "DAI",   name: "Dai Stablecoin",   decimals: 18 },
    tokenOut: { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", symbol: "USDC",  name: "USD Coin",         decimals: 6  },
    amountIn: "100000000000000000000", // 100 DAI
    priceLabel: "USDC per DAI",
  },
]


// ─── CoinGecko ID map (symbol → CoinGecko coin id) ───────────────────────────

const SYMBOL_TO_COINGECKO_ID: Record<string, string> = {
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
};

// ─── CoinGecko market data interface ─────────────────────────────────────────

export interface CoinGeckoMarketData {
  symbol: string;
  price_usd: number;
  volume_24h_usd: number;
  price_change_24h_pct: number;
  market_cap_usd: number;
}

// ─── Price-fetching output contract ───────────────────────────────────────────

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

// ─── On-chain pool snapshot ────────────────────────────────────────────────────

interface PoolSnapshot {
  address: string;
  token0Symbol: string;
  token0Address?: string;
  token1Symbol: string;
  token1Address?: string;
  feePct: number;
  priceLabel: string;
  currentPrice: number;
  /** virtual token1 amount at current tick — proxy for in-range liquidity */
  virtualToken1: number;
  /** pre-computed USD value of in-range liquidity — use this directly, do not re-estimate */
  liquidityUSD: number;
  liquidityRaw: string;
  tick: number;
}

// ─── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are the Research agent in a Uniswap trading swarm.
You receive live on-chain Uniswap V3 pool data and a trading plan, then you
produce a structured research report identifying the best candidate token pairs.

Pool data fields explained:
- currentPrice: human-readable price (see priceLabel for the pair direction)
- liquidityUSD: pre-computed total USD value of in-range liquidity — use this field directly
- virtualToken1: virtual in-range liquidity in token1 units (for reference)
- feePct: pool fee as a percentage (e.g., 0.05 = 0.05%)

Rules:
- Use the provided liquidityUSD value directly — do NOT re-estimate or recalculate it
- Only include candidates where liquidityUSD meets the minLiquidityUSD constraint
- Score candidates based on liquidityUSD depth and fee competitiveness
- Use currentPrice as priceUSD for the non-WETH/non-stablecoin token in the pair
- CRITICAL: The "address" field MUST be the full 42-character hex address (0x...) of the ERC-20 token
  Use token0Address or token1Address from the pool data — NEVER use a symbol like "WETH" as the address
- Output ONLY valid JSON matching the ResearchReport schema
- Never fabricate — use only the on-chain data provided

Schema:
{
  "timestamp": number,
  "marketSummary": "<2–3 sentence market overview>",
  "candidates": [
    {
      "address": "<token address (non-WETH/stablecoin token in the pair)>",
      "symbol": "<token symbol>",
      "name": "<token name>",
      "pairAddress": "<pool address>",
      "baseToken": "<WETH|USDC|USDT>",
      "priceUSD": number,
      "liquidityUSD": number,
      "volume24hUSD": number,
      "priceChange24hPct": number,
      "poolFeeTier": number,
      "txCount": number
    }
  ],
  "dataSource": "uniswap-v3-onchain"
}`;

// ─── ResearchAgent ─────────────────────────────────────────────────────────────

export class ResearchAgent {
  static readonly MEMORY_KEY = "researcher/report";
  readonly id = "researcher";
  readonly role = "Researcher";

  private readonly compute: ZGCompute;
  private readonly memory: BlackboardMemory;

  // ── Price-cache (15-second TTL to avoid redundant RPC/quote calls) ──────────
  private readonly CACHE_TTL_MS = 15_000;
  private readonly priceCache = new Map<
    string,
    { result: TokenPriceResult; expiresAt: number }
  >();

  // Lazy singleton provider — reused across all price + pool methods
  private _ethProvider: ethers.JsonRpcProvider | null = null;

  constructor(compute: ZGCompute, memory: BlackboardMemory) {
    this.compute = compute;
    this.memory = memory;
  }

  private getEthProvider(): ethers.JsonRpcProvider {
    if (!this._ethProvider) {
      const { ETH_RPC_URL } = getConfig();
      this._ethProvider = new ethers.JsonRpcProvider(ETH_RPC_URL, 1, {
        staticNetwork: true,
      });
    }
    return this._ethProvider;
  }

  /**
   * Researcher runs FIRST in the pipeline — before the Planner.
   * It fetches live on-chain data and writes the report to shared 0G memory.
   * The Planner then reads this report via contextFor() and uses it to plan.
   */
  async run(goal: string, opts: InferOptions = {}): Promise<ResearchReport> {
    logger.info(`[Researcher] Fetching Uniswap V3 pool data via Uniswap Trading API…`);

    const [pools, marketData] = await Promise.all([
      this.fetchOnChainPools(),
      this.fetchCoinGeckoMarketData(Object.keys(SYMBOL_TO_COINGECKO_ID)),
    ]);
    logger.info(`[Researcher] Fetched ${pools.length} pools from chain`);

    const cfg = getConfig();
    const context = this.memory.contextFor(ResearchAgent.MEMORY_KEY);

    // Build a compact market summary string from CoinGecko data (if available)
    let marketDataText = "";
    if (marketData.size > 0) {
      const lines = Array.from(marketData.entries()).map(
        ([sym, d]) =>
          `${sym}: price=$${d.price_usd.toFixed(4)} vol24h=$${(d.volume_24h_usd / 1e6).toFixed(1)}M chg24h=${d.price_change_24h_pct.toFixed(2)}% mcap=$${(d.market_cap_usd / 1e9).toFixed(2)}B`,
      );
      marketDataText = `\nLive CoinGecko market data (24h):\n${lines.join("\n")}`;
    }

    const userPrompt = [
      `Trading goal: ${goal}`,
      `Default constraints: maxSlippage=${cfg.MAX_SLIPPAGE_PCT}%, maxPosition=$${cfg.MAX_POSITION_USDC} USDC, minLiquidity=$${cfg.MIN_LIQUIDITY_USD.toLocaleString()}`,
      `Live Uniswap V3 on-chain pool snapshots:\n${JSON.stringify(pools, null, 2)}`,
      marketDataText,
      context,
    ]
      .filter(Boolean)
      .join("\n\n");

    const report = await this.compute.inferJSON<ResearchReport>(
      SYSTEM_PROMPT,
      userPrompt,
      { maxTokens: 2048, ...opts },
    );

    report.timestamp = Date.now();
    report.dataSource = "uniswap-v3-onchain";

    // Enrich candidates with CoinGecko volume + price change data
    for (const candidate of report.candidates as TokenCandidate[]) {
      const cg = marketData.get(candidate.symbol);
      if (cg) {
        if (!candidate.volume24hUSD || candidate.volume24hUSD === 0)
          candidate.volume24hUSD = cg.volume_24h_usd;
        if (!candidate.priceChange24hPct || candidate.priceChange24hPct === 0)
          candidate.priceChange24hPct = cg.price_change_24h_pct;
      }
    }

    // Hard-coded liquidity floor — Planner's plan may tighten this further
    report.candidates = report.candidates.filter(
      (c: TokenCandidate) => c.liquidityUSD >= cfg.MIN_LIQUIDITY_USD,
    );

    await this.memory.write(
      ResearchAgent.MEMORY_KEY,
      this.id,
      this.role,
      report,
    );
    logger.info(
      `[Researcher] Saved ${report.candidates.length} candidates to shared memory`,
    );
    return report;
  }

  // ── Uniswap Trading API pool data fetch ──────────────────────────────────────

  private async fetchOnChainPools(): Promise<PoolSnapshot[]> {
    const { UNISWAP_API_KEY } = getConfig();

    if (!UNISWAP_API_KEY) {
      throw new Error(
        "[Researcher] UNISWAP_API_KEY is not set. " +
          "Add it to your .env file — get a free key at https://developers.uniswap.org/dashboard. " +
          "Pool data cannot be fetched without a valid Uniswap API key.",
      );
    }

    const snapshots: PoolSnapshot[] = [];

    await Promise.all(
      QUERY_PAIRS.map(async (pair) => {
        try {
          const res = await fetch(`${UNISWAP_TRADE_API_BASE_URL}/quote`, {
            method: "POST",
            headers: {
              "x-api-key": UNISWAP_API_KEY,
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: JSON.stringify({
              tokenIn: pair.tokenIn.address,
              tokenOut: pair.tokenOut.address,
              tokenInChainId: 1,
              tokenOutChainId: 1,
              type: "EXACT_INPUT",
              amount: pair.amountIn,
              swapper: QUOTE_SWAPPER_ADDRESS,
              slippageTolerance: 0.5,
              protocols: ["V3"],
            }),
          });

          if (!res.ok) {
            const errText = await res.text();
            logger.warn(
              `[Researcher] Uniswap API ${res.status} for ${pair.tokenIn.symbol}/${pair.tokenOut.symbol}: ${errText}`,
            );
            return;
          }

          const data = (await res.json()) as UniswapAPIQuoteResponse;

          if (!data.quote || data.quote.route.length === 0) {
            logger.warn(
              `[Researcher] No route returned for ${pair.tokenIn.symbol}/${pair.tokenOut.symbol}` +
                (data.detail ? `: ${data.detail}` : ""),
            );
            return;
          }

          // Take the first (best) route's first pool hop
          const firstPath = data.quote.route[0];
          if (!firstPath || firstPath.length === 0) return;
          const pool = firstPath[0]!;
          if (pool.type !== "v3-pool") return;

          const inputAmt = Number(data.quote.input.amount);
          const outputAmt = Number(data.quote.output.amount);

          // currentPrice = human-unit output per human-unit input (e.g. 3200 USDC per WETH)
          const currentPrice =
            outputAmt /
            10 ** pair.tokenOut.decimals /
            (inputAmt / 10 ** pair.tokenIn.decimals);

          // Determine canonical token0/token1 by address order (lower = token0 in V3)
          const inLow  = pair.tokenIn.address.toLowerCase();
          const outLow = pair.tokenOut.address.toLowerCase();
          const [t0, t1] =
            inLow < outLow
              ? [pair.tokenIn, pair.tokenOut]
              : [pair.tokenOut, pair.tokenIn];

          // virtualToken1 ≈ L × sqrtPrice / 2^96 (in token1 human units)
          const sqrtPriceNum =
            Number(BigInt(pool.sqrtRatioX96)) / Number(2n ** 96n);
          const virtualToken1Raw = Number(BigInt(pool.liquidity)) * sqrtPriceNum;
          const virtualToken1 = virtualToken1Raw / 10 ** t1.decimals;

          snapshots.push({
            address: pool.address,
            token0Symbol:  t0.symbol,
            token0Address: t0.address,
            token1Symbol:  t1.symbol,
            token1Address: t1.address,
            feePct:       parseInt(pool.fee, 10) / 10_000,
            priceLabel:   pair.priceLabel,
            currentPrice: Number(currentPrice.toFixed(6)),
            virtualToken1: Number(virtualToken1.toFixed(4)),
            liquidityUSD:  0, // filled in post-processing below
            liquidityRaw:  pool.liquidity,
            tick:          pool.tick,
          });

          logger.debug(
            `[Researcher] ${pair.priceLabel}: ${currentPrice.toFixed(4)} ` +
              `(pool ${pool.address}, fee ${pool.fee})`,
          );
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn(
            `[Researcher] Failed to quote ${pair.tokenIn.symbol}/${pair.tokenOut.symbol}: ${msg}`,
          );
        }
      }),
    );

    // ── Compute liquidityUSD for each snapshot ────────────────────────────────
    // Strategy: find WETH/USD from the USDC/WETH or USDT/WETH snapshot, then
    // use it to price WETH-quoted pairs. Stablecoin-quoted pairs price directly.
    const stableSymbols = new Set(["USDC", "USDT", "DAI"]);

    // WETH USD price from the first stable/WETH pair we can find
    let wethUSD = 0;
    for (const s of snapshots) {
      if (
        (s.token0Symbol === "WETH" && stableSymbols.has(s.token1Symbol)) ||
        (s.token1Symbol === "WETH" && stableSymbols.has(s.token0Symbol))
      ) {
        // currentPrice is stable-per-WETH (e.g. 3200 USDC/WETH) or WETH-per-stable
        if (stableSymbols.has(s.token1Symbol)) {
          // price = token1(stable) per token0(WETH) → WETH price = currentPrice
          wethUSD = s.currentPrice;
        } else {
          // price = WETH per stable → WETH price = 1 / currentPrice
          wethUSD = 1 / s.currentPrice;
        }
        if (wethUSD > 100 && wethUSD < 1_000_000) break; // sanity
      }
    }
    if (wethUSD === 0) wethUSD = 3_000; // safe fallback if no WETH/stable pair fetched
    logger.debug(`[Researcher] WETH/USD reference price: $${wethUSD.toFixed(2)}`);

    for (const s of snapshots) {
      // virtualToken1 is in t1 human units. Compute USD value of the t1 side, double for t0.
      const t1Symbol = s.token1Symbol;
      let t1PriceUSD: number;
      if (stableSymbols.has(t1Symbol)) {
        t1PriceUSD = 1; // USDC / USDT / DAI ≈ $1
      } else if (t1Symbol === "WETH") {
        t1PriceUSD = wethUSD;
      } else {
        t1PriceUSD = 0; // unknown — skip
      }
      s.liquidityUSD =
        t1PriceUSD > 0
          ? Math.round(s.virtualToken1 * t1PriceUSD * 2)
          : 0;
      logger.debug(
        `[Researcher] ${s.token0Symbol}/${s.token1Symbol} liquidityUSD=$${s.liquidityUSD.toLocaleString()}`,
      );
    }

    // Sort by liquidityUSD descending (most liquid first)
    snapshots.sort((a, b) => b.liquidityUSD - a.liquidityUSD);

    if (snapshots.length === 0) {
      throw new Error(
        "[Researcher] No pool data could be retrieved from the Uniswap Trading API. " +
          "Verify your UNISWAP_API_KEY is valid, not rate-limited, and that the " +
          "token pairs have active V3 liquidity. Pipeline cannot proceed without pool data.",
      );
    }

    return snapshots;
  }

  // ── Public: fetch market data (volume, price change, mcap) from CoinGecko ───
  // Requires COINGECKO_API_KEY in env. Returns a map of symbol → market data.
  // Gracefully returns empty map if key is absent or API fails.

  async fetchCoinGeckoMarketData(
    symbols: string[],
  ): Promise<Map<string, CoinGeckoMarketData>> {
    const { COINGECKO_API_KEY } = getConfig();
    const result = new Map<string, CoinGeckoMarketData>();

    if (!COINGECKO_API_KEY) {
      logger.debug(
        "[Researcher] No COINGECKO_API_KEY set — skipping market data",
      );
      return result;
    }

    // Map symbols to CoinGecko IDs (deduplicated)
    const idToSymbols = new Map<string, string[]>();
    for (const sym of symbols) {
      const id = SYMBOL_TO_COINGECKO_ID[sym.toUpperCase()];
      if (!id) continue;
      const existing = idToSymbols.get(id) ?? [];
      existing.push(sym.toUpperCase());
      idToSymbols.set(id, existing);
    }

    if (idToSymbols.size === 0) return result;

    const ids = Array.from(idToSymbols.keys()).join(",");
    const url = `${COINGECKO_API_BASE_URL}/coins/markets?vs_currency=usd&ids=${ids}&order=market_cap_desc&per_page=50&page=1&price_change_percentage=24h&x_cg_demo_api_key=${COINGECKO_API_KEY}`;

    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json" },
      });

      if (!res.ok) {
        logger.warn(
          `[Researcher] CoinGecko API ${res.status}: ${await res.text()}`,
        );
        return result;
      }

      const coins = (await res.json()) as Array<{
        id: string;
        symbol: string;
        current_price: number;
        total_volume: number;
        price_change_percentage_24h: number;
        market_cap: number;
      }>;

      for (const coin of coins) {
        const syms = idToSymbols.get(coin.id) ?? [];
        const data: CoinGeckoMarketData = {
          symbol: coin.symbol.toUpperCase(),
          price_usd: coin.current_price,
          volume_24h_usd: coin.total_volume,
          price_change_24h_pct: coin.price_change_percentage_24h,
          market_cap_usd: coin.market_cap,
        };
        for (const sym of syms) {
          result.set(sym, data);
        }
        logger.debug(
          `[Researcher] CoinGecko ${coin.symbol.toUpperCase()}: $${coin.current_price} vol=$${(coin.total_volume / 1e6).toFixed(1)}M`,
        );
      }

      logger.info(
        `[Researcher] CoinGecko market data fetched for ${result.size} tokens`,
      );
    } catch (err) {
      logger.warn(
        `[Researcher] CoinGecko fetch error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return result;
  }

  // ── Public: fetch real-time USD prices from Uniswap on-chain data ─────────────
  // Input:  { tokens: ["ETH", "USDC", "WBTC"] }  (symbols or addresses)
  // Output: { data: TokenPriceResult[] }

  async fetchTokenPrices(tokens: string[]): Promise<PriceQuoteResponse> {
    const provider = this.getEthProvider();

    // Deduplicate while preserving input order
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const t of tokens) {
      const key = t.trim();
      if (key && !seen.has(key)) {
        seen.add(key);
        ordered.push(key);
      }
    }

    // Fetch prices + CoinGecko market data in parallel
    const [results, marketData] = await Promise.all([
      Promise.all(
        ordered.map((input) => this.resolveTokenPrice(input, provider)),
      ),
      this.fetchCoinGeckoMarketData(ordered),
    ]);

    // Merge CoinGecko fields into each result
    for (const r of results) {
      const cg = marketData.get(r.symbol);
      if (cg) {
        r.volume_24h_usd = cg.volume_24h_usd;
        r.price_change_24h_pct = cg.price_change_24h_pct;
        r.market_cap_usd = cg.market_cap_usd;
        // If Uniswap price failed, fall back to CoinGecko price
        if (r.price_usd === null) {
          r.price_usd = cg.price_usd;
        }
      }
    }

    return { data: results };
  }

  // ── Resolve a single token input (symbol OR address) ─────────────────────────

  private async resolveTokenPrice(
    input: string,
    provider: ethers.JsonRpcProvider,
  ): Promise<TokenPriceResult> {
    const upperSymbol = input.toUpperCase();
    const isAddress = /^0x[0-9a-fA-F]{40}$/.test(input);

    // ── Determine token definition ─────────────────────────────────────────────
    let tokenDef: TokenDef | undefined;
    let canonicalSymbol: string;

    if (isAddress) {
      const addressKey = input.toLowerCase();
      const knownSymbol = ADDRESS_TO_SYMBOL[addressKey];
      if (knownSymbol) {
        canonicalSymbol = knownSymbol;
        tokenDef = SYMBOL_TO_TOKEN[knownSymbol] as TokenDef;
      } else {
        // Unknown address — fetch symbol + decimals from chain
        try {
          const erc20 = new ethers.Contract(input, ERC20_META_ABI, provider);
          const [symbol, decimals] = await Promise.all([
            erc20.getFunction("symbol")() as Promise<string>,
            erc20.getFunction("decimals")() as Promise<bigint>,
          ]);
          canonicalSymbol = symbol;
          tokenDef = {
            address: ethers.getAddress(input),
            decimals: Number(decimals),
          };
        } catch {
          return {
            symbol: input,
            address: input,
            price_usd: null,
            source: "uniswap",
            liquidity_used: "NONE",
          };
        }
      }
    } else {
      canonicalSymbol = upperSymbol;
      tokenDef = SYMBOL_TO_TOKEN[upperSymbol] as TokenDef | undefined;
      if (!tokenDef) {
        logger.warn(`[Researcher] Unknown token symbol: ${input}`);
        return {
          symbol: input,
          address: "0x",
          price_usd: null,
          source: "uniswap",
          liquidity_used: "NONE",
        };
      }
    }

    // Guard: tokenDef must be defined by this point (all undefined paths return early above)
    if (!tokenDef) {
      return {
        symbol: input,
        address: "0x",
        price_usd: null,
        source: "uniswap",
        liquidity_used: "NONE",
      };
    }

    // ── Cache check ───────────────────────────────────────────────────────────
    const cacheKey = tokenDef.address.toLowerCase();
    const cached = this.priceCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      logger.debug(`[Researcher] Cache hit for ${canonicalSymbol}`);
      return cached.result;
    }

    // ── Stablecoins (USDC, USDT, DAI) — $1 by definition ───────────────────
    if (tokenDef.isStablecoin) {
      const result: TokenPriceResult = {
        symbol: canonicalSymbol,
        address: tokenDef.address,
        price_usd: 1.0,
        source: "uniswap",
        liquidity_used: "TOKEN/USDC",
      };
      this.priceCache.set(cacheKey, {
        result,
        expiresAt: Date.now() + this.CACHE_TTL_MS,
      });
      return result;
    }

    // ── STEP 2A: Uniswap Trading API (PRIMARY — uses API key) ─────────────────
    const apiPrice = await this.priceViaTradeApi(tokenDef, canonicalSymbol);
    if (apiPrice !== null) {
      const result: TokenPriceResult = {
        symbol: canonicalSymbol,
        address: tokenDef.address,
        price_usd: apiPrice,
        source: "uniswap",
        liquidity_used: "TOKEN/USDC",
      };
      this.priceCache.set(cacheKey, {
        result,
        expiresAt: Date.now() + this.CACHE_TTL_MS,
      });
      return result;
    }

    // ── STEP 2B: On-chain QuoterV2 (FALLBACK — no API key needed) ────────────
    const quotePrice = await this.priceViaQuote(tokenDef, provider);
    if (quotePrice !== null) {
      const result: TokenPriceResult = {
        symbol: canonicalSymbol,
        address: tokenDef.address,
        price_usd: quotePrice,
        source: "uniswap",
        liquidity_used: "TOKEN/USDC",
      };
      this.priceCache.set(cacheKey, {
        result,
        expiresAt: Date.now() + this.CACHE_TTL_MS,
      });
      return result;
    }

    // ── STEP 2C: Pool slot0 pricing (SECONDARY FALLBACK) ─────────────────────
    const poolResult = await this.priceViaPool(tokenDef, provider);
    if (poolResult !== null) {
      const result: TokenPriceResult = {
        symbol: canonicalSymbol,
        address: tokenDef.address,
        price_usd: poolResult.price,
        source: "uniswap",
        liquidity_used: poolResult.pairLabel,
      };
      this.priceCache.set(cacheKey, {
        result,
        expiresAt: Date.now() + this.CACHE_TTL_MS,
      });
      return result;
    }

    // ── STEP 3: Validation failed / unresolvable ──────────────────────────────
    const failed: TokenPriceResult = {
      symbol: canonicalSymbol,
      address: tokenDef.address,
      price_usd: null,
      source: "uniswap",
      liquidity_used: "NONE",
    };
    return failed;
  }

  // ── STEP 2A: Uniswap Trading API pricing ─────────────────────────────────────
  // Calls POST /v1/quote with EXACT_INPUT: 1 TOKEN → USDC.
  // Returns null if API key is absent, token is USDC, or request fails.

  private async priceViaTradeApi(
    token: TokenDef,
    symbol: string,
  ): Promise<number | null> {
    const { UNISWAP_API_KEY } = getConfig();
    if (!UNISWAP_API_KEY) return null; // no key — skip to QuoterV2

    if (token.address.toLowerCase() === USDC_DEF.address.toLowerCase())
      return null;

    // The Trading API uses 0x000...000 for native ETH, ERC-20 address otherwise.
    // For WETH we also pass the ERC-20 address (the API handles wrapping internally).
    const tokenInAddress = token.address;
    const amountIn = (BigInt(10) ** BigInt(token.decimals)).toString(); // 1 full token

    try {
      const response = await fetch(`${UNISWAP_TRADE_API_BASE_URL}/quote`, {
        method: "POST",
        headers: {
          "x-api-key": UNISWAP_API_KEY,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          tokenIn: tokenInAddress,
          tokenOut: USDC_DEF.address,
          amount: amountIn,
          type: "EXACT_INPUT",
          tokenInChainId: 1,
          tokenOutChainId: 1,
          // A non-zero placeholder — required by the API but not used for simulation
          swapper: "0x0000000000000000000000000000000000000001",
        }),
      });

      if (!response.ok) {
        logger.warn(
          `[Researcher] Trade API ${response.status} for ${symbol}: ${await response.text()}`,
        );
        return null;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = (await response.json()) as Record<string, any>;
      const quote = body["quote"] as Record<string, unknown> | undefined;
      if (!quote) return null;

      // ── CLASSIC routing: quote.output.amount (USDC smallest units) ───────────
      const classicOutput = (
        quote["output"] as Record<string, unknown> | undefined
      )?.["amount"];
      if (typeof classicOutput === "string") {
        const price = Number(classicOutput) / 10 ** USDC_DEF.decimals;
        if (this.isPriceValid(price, token)) {
          logger.debug(
            `[Researcher] Trade API (CLASSIC) ${symbol} → USDC: $${price}`,
          );
          return price;
        }
      }

      // ── UniswapX/Dutch routing: quote.orderInfo.outputs[0].startAmount ────────
      const orderInfo = quote["orderInfo"] as
        | Record<string, unknown>
        | undefined;
      const outputs = orderInfo?.["outputs"];
      if (Array.isArray(outputs) && outputs.length > 0) {
        const firstOut = outputs[0] as Record<string, unknown>;
        const startAmt = firstOut["startAmount"];
        if (typeof startAmt === "string") {
          const price = Number(startAmt) / 10 ** USDC_DEF.decimals;
          if (this.isPriceValid(price, token)) {
            logger.debug(
              `[Researcher] Trade API (UniswapX) ${symbol} → USDC: $${price}`,
            );
            return price;
          }
        }
      }

      logger.warn(
        `[Researcher] Trade API returned unrecognised quote shape for ${symbol}`,
      );
      return null;
    } catch (err) {
      logger.warn(
        `[Researcher] Trade API fetch error for ${symbol}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  // ── STEP 2B: Quote-based pricing via QuoterV2.quoteExactInputSingle ──────────
  // Simulates selling exactly 1 TOKEN → USDC across all fee tiers.
  // Returns the USD price on first successful quote, null otherwise.

  private async priceViaQuote(
    token: TokenDef,
    provider: ethers.JsonRpcProvider,
  ): Promise<number | null> {
    // If the token IS USDC, skip (handled as stablecoin above)
    if (token.address.toLowerCase() === USDC_DEF.address.toLowerCase())
      return null;

    const quoter = new ethers.Contract(
      UNISWAP.QUOTER_V2,
      QUOTER_V2_ABI,
      provider,
    );
    const amountIn = BigInt(10 ** token.decimals); // simulate 1 full token

    for (const fee of FEE_TIERS) {
      try {
        // staticCall prevents any state mutation; ethers v6 returns an array
        const [amountOut] = (await quoter
          .getFunction("quoteExactInputSingle")
          .staticCall({
            tokenIn: token.address,
            tokenOut: USDC_DEF.address,
            amountIn,
            fee,
            sqrtPriceLimitX96: 0n,
          })) as [bigint, ...unknown[]];

        // amountOut is in USDC (6 decimals)
        const priceUSD = Number(amountOut) / 10 ** USDC_DEF.decimals;
        if (priceUSD > 0 && this.isPriceValid(priceUSD, token)) {
          logger.debug(
            `[Researcher] QuoterV2 price ${token.address} → USDC (fee=${fee}): $${priceUSD}`,
          );
          return priceUSD;
        }
      } catch {
        // Pool at this fee tier doesn't exist or has no liquidity — try next
      }
    }

    return null;
  }

  // ── STEP 2B: Pool slot0 pricing (TOKEN/USDC then TOKEN/WETH) ─────────────────
  // Falls back to reading sqrtPriceX96 from the highest-liquidity pool.

  private async priceViaPool(
    token: TokenDef,
    provider: ethers.JsonRpcProvider,
  ): Promise<{ price: number; pairLabel: string } | null> {
    const factory = new ethers.Contract(UNISWAP.FACTORY, FACTORY_ABI, provider);

    // ── Try TOKEN/USDC pools ──────────────────────────────────────────────────
    const usdcResult = await this.priceFromSlot0(
      token,
      USDC_DEF,
      factory,
      provider,
    );
    if (usdcResult !== null) {
      logger.debug(
        `[Researcher] slot0 price ${token.address}/USDC: $${usdcResult}`,
      );
      return { price: usdcResult, pairLabel: "TOKEN/USDC" };
    }

    // ── Try TOKEN/WETH pools then convert via WETH/USDC ──────────────────────
    // First get WETH price in USD (use quote, then fall back to slot0)
    let wethPriceUSD = (await this.priceViaQuote(WETH_DEF, provider)) ?? null;
    if (wethPriceUSD === null) {
      const wethSlot = await this.priceFromSlot0(
        WETH_DEF,
        USDC_DEF,
        factory,
        provider,
      );
      wethPriceUSD = wethSlot;
    }
    if (wethPriceUSD === null) return null;

    const wethResult = await this.priceFromSlot0(
      token,
      WETH_DEF,
      factory,
      provider,
    );
    if (wethResult !== null) {
      const priceUSD = wethResult * wethPriceUSD;
      if (this.isPriceValid(priceUSD, token)) {
        logger.debug(
          `[Researcher] slot0 price ${token.address}/WETH: $${priceUSD}`,
        );
        return { price: priceUSD, pairLabel: "TOKEN/WETH" };
      }
    }

    return null;
  }

  // ── Compute price from a pool's slot0 (highest-liquidity fee tier wins) ──────
  // Returns the price of `tokenA` in terms of `quoteToken` (USD if USDC, WETH otherwise).

  private async priceFromSlot0(
    tokenA: TokenDef,
    quoteToken: TokenDef,
    factory: ethers.Contract,
    provider: ethers.JsonRpcProvider,
  ): Promise<number | null> {
    let bestLiquidity = 0n;
    let bestPrice: number | null = null;

    for (const fee of FEE_TIERS) {
      try {
        const poolAddr = (await factory.getFunction("getPool")(
          tokenA.address,
          quoteToken.address,
          fee,
        )) as string;
        if (!poolAddr || poolAddr === ethers.ZeroAddress) continue;

        const pool = new ethers.Contract(poolAddr, POOL_ABI, provider);
        const [slot0Result, liquidityRaw] = await Promise.all([
          pool.getFunction("slot0")({ blockTag: "finalized" }) as Promise<
            [bigint, bigint, ...unknown[]]
          >,
          pool.getFunction("liquidity")({
            blockTag: "finalized",
          }) as Promise<bigint>,
        ]);

        const sqrtPriceX96 = slot0Result[0];
        if (sqrtPriceX96 === 0n) continue;

        // Determine token ordering (lower address = token0 in Uniswap V3)
        const aIsToken0 =
          tokenA.address.toLowerCase() < quoteToken.address.toLowerCase();

        // price_raw = (sqrtPriceX96 / Q96)^2 = token1_units / token0_units
        const Q96 = 2n ** 96n;
        const sqrtNum = Number(sqrtPriceX96) / Number(Q96);
        const rawPrice = sqrtNum * sqrtNum;

        // Convert to human-readable price of tokenA in quoteToken
        let priceAInQuote: number;
        if (aIsToken0) {
          // tokenA = token0, quoteToken = token1
          // rawPrice = quoteToken_units / tokenA_units
          // tokenA human price = rawPrice * 10^(d_tokenA - d_quoteToken)
          // No wait: rawPrice = (token1_smallest / token0_smallest)
          // 1 human tokenA = 10^d_A token0 units → worth rawPrice * 10^d_A token1 units → / 10^d_quote
          priceAInQuote =
            rawPrice * Math.pow(10, tokenA.decimals - quoteToken.decimals);
        } else {
          // tokenA = token1, quoteToken = token0
          // rawPrice = tokenA_units / quoteToken_units
          // 1 human tokenA = rawPrice * 10^(-d_A) quoteToken_units per tokenA_unit × 10^d_A
          // priceAInQuote = 1 / (rawPrice * 10^(d_quoteToken - d_A))
          priceAInQuote =
            1 /
            (rawPrice * Math.pow(10, quoteToken.decimals - tokenA.decimals));
        }

        // Estimate virtual liquidity in USD to pick the deepest pool
        // virtualQuote ≈ L * sqrtPrice / Q96 (in quote token smallest units)
        const virtualQuoteUnits =
          (Number(liquidityRaw) * Number(sqrtPriceX96)) / Number(Q96);
        const virtualQuoteHuman =
          virtualQuoteUnits / Math.pow(10, quoteToken.decimals);
        const liquidityUSD =
          virtualQuoteHuman * (quoteToken === USDC_DEF ? 1 : 1); // WETH leg handled by caller

        if (liquidityUSD < MIN_POOL_LIQUIDITY_USD) continue;

        if (liquidityRaw > bestLiquidity) {
          bestLiquidity = liquidityRaw;
          bestPrice = priceAInQuote;
        }
      } catch {
        continue;
      }
    }

    if (bestPrice !== null && this.isPriceValid(bestPrice, tokenA)) {
      return bestPrice;
    }
    return null;
  }

  // ── STEP 3: Validation ────────────────────────────────────────────────────────
  // Stablecoins: must be within ±2% of $1. Others: reject ≤0 or obviously absurd.

  private isPriceValid(price: number, token: TokenDef): boolean {
    if (!isFinite(price) || price <= 0) return false;
    if (token.isStablecoin) {
      return Math.abs(price - 1.0) <= 0.02; // ±2 % band
    }
    // Reject implausibly small (<$0.000001) or large (>$10M) prices
    return price >= 1e-6 && price <= 10_000_000;
  }
}
