import { UNISWAP_TRADE_API_BASE_URL, getConfig, logger } from "@swarm/shared";

import {
  NARRATIVE_EXTRA_SYMBOLS,
  QUERY_PAIRS,
  QUOTE_SWAPPER_ADDRESS,
  SYMBOL_TO_TOKEN,
  WETH_DEF,
} from "../core/constants";
import type {
  CoinGeckoMarketData,
  PoolSnapshot,
  QueryPair,
  UniswapAPIQuoteResponse,
} from "../core/types";
import { fetchTrendingTokens } from "./trendingPairs";

const BASE_SYMBOLS = new Set(["WETH", "USDC", "USDT", "DAI"]);
const STABLE_SYMBOLS = new Set(["USDC", "USDT", "DAI"]);

/** Result of fetchOnChainPools — includes trending token CoinGecko IDs for market-data enrichment */
export interface OnChainPoolsResult {
  snapshots: PoolSnapshot[];
  /** symbol (upper-case) → CoinGecko coin ID for live-trending tokens */
  trendingCoinGeckoIds: Map<string, string>;
  /** Top trending symbols from CoinGecko so other services don't refetch */
  trendingSymbols: string[];
}

/**
 * Builds QueryPairs for every token that appears in any narrative's extra-symbols
 * list AND is registered in SYMBOL_TO_TOKEN (known mainnet address + decimals).
 * Filters out symbols already covered by the static QUERY_PAIRS set.
 */
function buildNarrativeExtraPairs(knownSymbols: Set<string>): QueryPair[] {
  const allNarrativeSymbols = new Set(
    Object.values(NARRATIVE_EXTRA_SYMBOLS).flat(),
  );
  const pairs: QueryPair[] = [];

  for (const symbol of allNarrativeSymbols) {
    if (knownSymbols.has(symbol)) continue;
    const def = SYMBOL_TO_TOKEN[symbol];
    if (!def) continue; // unknown token — skip

    const amountIn = (10n ** BigInt(def.decimals)).toString();
    pairs.push({
      tokenIn: {
        address: def.address,
        symbol,
        name: symbol,
        decimals: def.decimals,
      },
      tokenOut: {
        address: WETH_DEF.address,
        symbol: "WETH",
        name: "Wrapped Ether",
        decimals: WETH_DEF.decimals,
      },
      amountIn,
      priceLabel: `WETH per ${symbol}`,
    });
    logger.debug(`[Researcher] Narrative extra pair queued: ${symbol} vs WETH`);
  }

  return pairs;
}

export async function fetchOnChainPools(): Promise<OnChainPoolsResult> {
  const { UNISWAP_API_KEY } = getConfig();

  if (!UNISWAP_API_KEY) {
    throw new Error(
      "[Researcher] UNISWAP_API_KEY is not set. " +
        "Add it to your .env file - get a free key at https://developers.uniswap.org/dashboard. " +
        "Pool data cannot be fetched without a valid Uniswap API key.",
    );
  }

  // Fetch static curated pairs + live trending tokens in parallel
  const [snapshots, trendingResult] = await Promise.all([
    fetchPoolSnapshots(UNISWAP_API_KEY, QUERY_PAIRS),
    fetchTrendingTokens(),
  ]);

  // Symbols already covered so we can deduplicate
  const existingSymbols = new Set(snapshots.map((s) => s.tokenSymbol));

  // Add narrative extra tokens (uses known SYMBOL_TO_TOKEN registry — no RPC call)
  const narrativePairs = buildNarrativeExtraPairs(existingSymbols);
  if (narrativePairs.length > 0) {
    logger.info(
      `[Researcher] Fetching ${narrativePairs.length} narrative extra pair(s): ${narrativePairs.map((p) => p.tokenIn.symbol).join(", ")}`,
    );
    const narrativeSnapshots = await fetchPoolSnapshots(
      UNISWAP_API_KEY,
      narrativePairs,
    );
    snapshots.push(...narrativeSnapshots);
    for (const s of narrativeSnapshots) existingSymbols.add(s.tokenSymbol);
  }

  // Quote trending tokens that aren't already covered
  const newTrendingPairs = trendingResult.pairs.filter(
    (p) => !existingSymbols.has(p.tokenIn.symbol),
  );

  if (newTrendingPairs.length > 0) {
    const trendingSnapshots = await fetchPoolSnapshots(
      UNISWAP_API_KEY,
      newTrendingPairs,
    );
    snapshots.push(...trendingSnapshots);
  }

  if (snapshots.length === 0) {
    throw new Error(
      "[Researcher] No pool data could be retrieved from the Uniswap Trading API. " +
        "Verify your UNISWAP_API_KEY is valid, not rate-limited, and that the " +
        "token pairs have active Uniswap liquidity. Pipeline cannot proceed without pool data.",
    );
  }

  return {
    snapshots,
    trendingCoinGeckoIds: trendingResult.coinGeckoIds,
    trendingSymbols: trendingResult.trendingSymbols,
  };
}

async function fetchPoolSnapshots(
  uniswapApiKey: string,
  pairs: QueryPair[],
): Promise<PoolSnapshot[]> {
  const snapshots: PoolSnapshot[] = [];

  await Promise.all(
    pairs.map(async (pair) => {
      const snapshot = await fetchPoolSnapshotForPair(pair, uniswapApiKey);
      if (snapshot) snapshots.push(snapshot);
    }),
  );

  return snapshots;
}

async function fetchPoolSnapshotForPair(
  pair: QueryPair,
  uniswapApiKey: string,
): Promise<PoolSnapshot | null> {
  try {
    const data = await fetchUniswapQuoteForPair(pair, uniswapApiKey);
    if (!data) {
      // fetchUniswapQuoteForPair already logged a status-specific message.
      return null;
    }
    const quote = data?.quote;

    // The Trading API can return:
    //  - a classic pool quote with a populated `route: pool[][]`,
    //  - a UniswapX quote whose payload omits `route` entirely or returns it
    //    as `undefined`,
    //  - or an error envelope (`errorCode` + `detail`) with no `quote` at all.
    // Defensively guard every level so non-classic responses don't crash with
    // "Cannot read properties of undefined (reading 'length')".
    if (!quote) {
      logger.warn(
        `[Researcher] No quote returned for ${pair.tokenIn.symbol}/${pair.tokenOut.symbol}` +
          (data?.detail ? `: ${data.detail}` : "") +
          (data?.errorCode ? ` [${data.errorCode}]` : ""),
      );
      return null;
    }

    const route = Array.isArray(quote.route) ? quote.route : [];
    if (route.length === 0) {
      logger.debug(
        `[Researcher] Skipping ${pair.tokenIn.symbol}/${pair.tokenOut.symbol}: ` +
          `${data?.routing ?? "non-classic"} routing without an exposed pool route.`,
      );
      return null;
    }

    const firstPath = Array.isArray(route[0]) ? route[0] : [];
    if (firstPath.length === 0) return null;

    const pool = firstPath[0];
    if (
      !pool ||
      typeof pool.type !== "string" ||
      !pool.type.endsWith("-pool")
    ) {
      return null;
    }

    const snapshot = buildSnapshotFromQuote(pair, quote, pool);
    logger.debug(
      `[Researcher] ${pair.priceLabel}: ${snapshot.currentPrice.toFixed(4)} ` +
        `(${pool.type} ${pool.address}, fee ${pool.fee})`,
    );
    return snapshot;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(
      `[Researcher] Failed to quote ${pair.tokenIn.symbol}/${pair.tokenOut.symbol}: ${msg}`,
    );
    return null;
  }
}

async function fetchUniswapQuoteForPair(
  pair: QueryPair,
  uniswapApiKey: string,
): Promise<UniswapAPIQuoteResponse | null> {
  const res = await fetch(`${UNISWAP_TRADE_API_BASE_URL}/quote`, {
    method: "POST",
    headers: {
      "x-api-key": uniswapApiKey,
      "x-universal-router-version": "2.0",
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      tokenIn: pair.tokenIn.address,
      tokenOut: pair.tokenOut.address,
      // tokenInChainId / tokenOutChainId MUST be strings per the Trading API spec.
      tokenInChainId: "1",
      tokenOutChainId: "1",
      type: "EXACT_INPUT",
      amount: pair.amountIn,
      swapper: QUOTE_SWAPPER_ADDRESS,
      slippageTolerance: 0.5,
      protocols: ["V2", "V3", "V4", "UNISWAPX_V2"],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    if (res.status === 403) {
      logger.debug(
        `[Researcher] Uniswap API 403 (tier-limited) for ${pair.tokenIn.symbol}/${pair.tokenOut.symbol}`,
      );
      return null;
    }
    logger.warn(
      `[Researcher] Uniswap API ${res.status} for ${pair.tokenIn.symbol}/${pair.tokenOut.symbol}: ${errText}`,
    );
    return null;
  }

  return (await res.json()) as UniswapAPIQuoteResponse;
}

type ClassicQuote = NonNullable<UniswapAPIQuoteResponse["quote"]>;
type ClassicRoutePool = NonNullable<ClassicQuote["route"]>[number][number];

function buildSnapshotFromQuote(
  pair: QueryPair,
  quote: ClassicQuote,
  pool: ClassicRoutePool,
): PoolSnapshot {
  const inputAmt = Number(quote.input.amount);
  const outputAmt = Number(quote.output.amount);
  const currentPrice =
    outputAmt /
    10 ** pair.tokenOut.decimals /
    (inputAmt / 10 ** pair.tokenIn.decimals);

  const inLow = pair.tokenIn.address.toLowerCase();
  const outLow = pair.tokenOut.address.toLowerCase();
  const [, t1] =
    inLow < outLow
      ? [pair.tokenIn, pair.tokenOut]
      : [pair.tokenOut, pair.tokenIn];

  const sqrtRaw = pool.sqrtRatioX96 ?? "0";
  const liquidityRaw = pool.liquidity ?? "0";
  // Use BigInt arithmetic throughout to avoid IEEE-754 precision loss when
  // liquidityRaw or sqrtRatioX96 exceed 2^53 (common for large V3 pools).
  // Formula: virtualToken1 = floor(L × √P / 2^96) / 10^decimals
  //        = floor(L × sqrtRatioX96 / (2^96 × 10^decimals))
  let virtualToken1 = 0;
  if (sqrtRaw !== "0" && liquidityRaw !== "0") {
    try {
      const scale = 2n ** 96n * 10n ** BigInt(t1.decimals);
      virtualToken1 = Number((BigInt(liquidityRaw) * BigInt(sqrtRaw)) / scale);
    } catch {
      virtualToken1 = 0;
    }
  }

  const isInBase = BASE_SYMBOLS.has(pair.tokenIn.symbol);
  const tradeTok = isInBase ? pair.tokenOut : pair.tokenIn;
  const baseTok = isInBase ? pair.tokenIn : pair.tokenOut;

  return {
    poolAddress: pool.address,
    tokenAddress: tradeTok.address,
    tokenSymbol: tradeTok.symbol,
    tokenName: tradeTok.name,
    baseTokenSymbol: baseTok.symbol,
    baseTokenAddress: baseTok.address,
    protocol: pool.type,
    feePct: parseInt(pool.fee || "0", 10) / 10_000,
    priceLabel: pair.priceLabel,
    currentPrice: Number(currentPrice.toFixed(6)),
    virtualToken1: Number(virtualToken1.toFixed(4)),
    liquidityUSD: 0,
    liquidityRaw: liquidityRaw,
    tick: pool.tick ?? 0,
  };
}

/**
 * Populates `liquidityUSD` on every snapshot.
 *
 * When `marketData` is supplied, each token's estimate is additionally capped at
 * `MARKET_CAP_LIQUIDITY_RATIO × marketCap`. Uniswap V3 concentrated liquidity
 * inflates the L-based virtual-reserve estimate well beyond real TVL; the market-cap
 * ceiling keeps rankings meaningful without requiring an extra subgraph call.
 */
export function populateLiquidityUSD(
  snapshots: PoolSnapshot[],
  marketData?: Map<string, CoinGeckoMarketData>,
): void {
  const wethUSD = findWethUsdReferencePrice(snapshots);
  logger.debug(`[Researcher] WETH/USD reference price: $${wethUSD.toFixed(2)}`);

  for (const s of snapshots) {
    const basePriceUSD = resolveBaseTokenPriceUSD(s.baseTokenSymbol, wethUSD);
    const estimated =
      basePriceUSD > 0 ? Math.round(s.virtualToken1 * basePriceUSD * 2) : 0;

    const mktCap = marketData?.get(s.tokenSymbol)?.market_cap_usd;
    s.liquidityUSD = normalizeLiquidityUSD(estimated, mktCap);
    logger.debug(
      `[Researcher] ${s.tokenSymbol}/${s.baseTokenSymbol} (${s.protocol}) liquidityUSD=$${s.liquidityUSD.toLocaleString()}`,
    );
  }
}

// Absolute ceiling regardless of market cap — prevents any single token from
// dominating rankings due to a formula artefact.
const MAX_REASONABLE_LIQUIDITY_USD = 250_000_000;
// Pool TVL in Uniswap V3 rarely exceeds ~2 % of a token's circulating market cap;
// using market cap as a tighter ceiling prevents the L×√P virtual-reserve formula
// from inflating concentrated-liquidity pools into the $250 M sentinel range.
const MARKET_CAP_LIQUIDITY_RATIO = 0.02;

function normalizeLiquidityUSD(value: number, marketCapUSD?: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const marketCapCap =
    marketCapUSD && marketCapUSD > 0
      ? Math.round(marketCapUSD * MARKET_CAP_LIQUIDITY_RATIO)
      : MAX_REASONABLE_LIQUIDITY_USD;
  return Math.min(
    Math.round(value),
    marketCapCap,
    MAX_REASONABLE_LIQUIDITY_USD,
  );
}

function findWethUsdReferencePrice(snapshots: PoolSnapshot[]): number {
  for (const s of snapshots) {
    if (
      (s.tokenSymbol === "WETH" && STABLE_SYMBOLS.has(s.baseTokenSymbol)) ||
      (s.baseTokenSymbol === "WETH" && STABLE_SYMBOLS.has(s.tokenSymbol))
    ) {
      const wethUSD = STABLE_SYMBOLS.has(s.baseTokenSymbol)
        ? s.currentPrice
        : 1 / s.currentPrice;
      if (wethUSD > 100 && wethUSD < 1_000_000) {
        return wethUSD;
      }
    }
  }

  return 3_000;
}

function resolveBaseTokenPriceUSD(baseSymbol: string, wethUSD: number): number {
  if (STABLE_SYMBOLS.has(baseSymbol)) return 1;
  if (baseSymbol === "WETH") return wethUSD;
  return 0;
}
