import { UNISWAP_TRADE_API_BASE_URL, getConfig, logger } from "@swarm/shared";

import { QUERY_PAIRS, QUOTE_SWAPPER_ADDRESS } from "../core/constants";
import type {
  PoolSnapshot,
  QueryPair,
  UniswapAPIQuoteResponse,
} from "../core/types";

const BASE_SYMBOLS = new Set(["WETH", "USDC", "USDT", "DAI"]);
const STABLE_SYMBOLS = new Set(["USDC", "USDT", "DAI"]);

export async function fetchOnChainPools(): Promise<PoolSnapshot[]> {
  const { UNISWAP_API_KEY } = getConfig();

  if (!UNISWAP_API_KEY) {
    throw new Error(
      "[Researcher] UNISWAP_API_KEY is not set. " +
        "Add it to your .env file - get a free key at https://developers.uniswap.org/dashboard. " +
        "Pool data cannot be fetched without a valid Uniswap API key.",
    );
  }

  const snapshots = await fetchPoolSnapshots(UNISWAP_API_KEY);
  populateLiquidityUSD(snapshots);
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

async function fetchPoolSnapshots(
  uniswapApiKey: string,
): Promise<PoolSnapshot[]> {
  const snapshots: PoolSnapshot[] = [];

  await Promise.all(
    QUERY_PAIRS.map(async (pair) => {
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
    const quote = data?.quote;
    if (!quote || quote.route.length === 0) {
      logger.warn(
        `[Researcher] No route returned for ${pair.tokenIn.symbol}/${pair.tokenOut.symbol}` +
          (data?.detail ? `: ${data.detail}` : ""),
      );
      return null;
    }

    const firstPath = quote.route[0];
    if (!firstPath || firstPath.length === 0) return null;

    const pool = firstPath[0]!;
    if (!pool.type.endsWith("-pool")) return null;

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
      protocols: ["V2", "V3", "V4", "UNISWAPX_V2"],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    logger.warn(
      `[Researcher] Uniswap API ${res.status} for ${pair.tokenIn.symbol}/${pair.tokenOut.symbol}: ${errText}`,
    );
    return null;
  }

  return (await res.json()) as UniswapAPIQuoteResponse;
}

function buildSnapshotFromQuote(
  pair: QueryPair,
  quote: NonNullable<UniswapAPIQuoteResponse["quote"]>,
  pool: NonNullable<UniswapAPIQuoteResponse["quote"]>["route"][number][number],
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
  const sqrtPriceNum =
    sqrtRaw !== "0" ? Number(BigInt(sqrtRaw)) / Number(2n ** 96n) : 0;
  const virtualToken1Raw =
    liquidityRaw !== "0" ? Number(BigInt(liquidityRaw)) * sqrtPriceNum : 0;
  const virtualToken1 = virtualToken1Raw / 10 ** t1.decimals;

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

function populateLiquidityUSD(snapshots: PoolSnapshot[]): void {
  const wethUSD = findWethUsdReferencePrice(snapshots);
  logger.debug(`[Researcher] WETH/USD reference price: $${wethUSD.toFixed(2)}`);

  for (const s of snapshots) {
    const basePriceUSD = resolveBaseTokenPriceUSD(s.baseTokenSymbol, wethUSD);
    s.liquidityUSD =
      basePriceUSD > 0 ? Math.round(s.virtualToken1 * basePriceUSD * 2) : 0;
    logger.debug(
      `[Researcher] ${s.tokenSymbol}/${s.baseTokenSymbol} (${s.protocol}) liquidityUSD=$${s.liquidityUSD.toLocaleString()}`,
    );
  }
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
