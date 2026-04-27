import { COINGECKO_API_BASE_URL, getConfig, logger } from "@swarm/shared";

import { WETH_DEF } from "../core/constants";
import type { QueryPair } from "../core/types";

interface TrendingCoinItem {
  id: string;
  symbol: string;
  name: string;
  platforms?: Record<string, string>;
  /** Richer platform data including contract address and decimal count */
  detail_platforms?: Record<
    string,
    { contract_address?: string; decimal_place?: number | null } | undefined
  >;
  data?: { price?: number };
}

interface CoinGeckoTrendingResponse {
  coins?: Array<{ item: TrendingCoinItem }>;
}

/** Pairs plus a symbol→CoinGecko-ID map for market data enrichment */
export interface TrendingResult {
  pairs: QueryPair[];
  /** Maps token symbol (upper-case) to its CoinGecko coin ID */
  coinGeckoIds: Map<string, string>;
  /** Top trending symbols from CoinGecko (upper-case), regardless of chain */
  trendingSymbols: string[];
}

/**
 * Fetches the top trending coins from CoinGecko and returns those that have
 * an Ethereum mainnet contract address as Uniswap-quotable QueryPairs
 * (each paired against WETH as the base token).
 *
 * Decimals are resolved from CoinGecko's `detail_platforms.ethereum.decimal_place`
 * field which is included in the trending response — no extra RPC call needed.
 *
 * Falls back to an empty result on any error so the main pipeline is never blocked.
 */
export async function fetchTrendingTokens(): Promise<TrendingResult> {
  const empty: TrendingResult = {
    pairs: [],
    coinGeckoIds: new Map(),
    trendingSymbols: [],
  };
  const { COINGECKO_API_KEY } = getConfig();

  if (!COINGECKO_API_KEY) {
    logger.debug(
      "[Researcher] No COINGECKO_API_KEY — skipping trending-token pair discovery",
    );
    return empty;
  }

  try {
    const url = `${COINGECKO_API_BASE_URL}/search/trending`;
    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        "x-cg-demo-api-key": COINGECKO_API_KEY,
      },
    });

    if (!res.ok) {
      logger.warn(`[Researcher] CoinGecko trending ${res.status} — skipping`);
      return empty;
    }

    const json = (await res.json()) as CoinGeckoTrendingResponse;
    const coins = json.coins ?? [];
    const trendingSymbols = coins
      .map((c) => c.item.symbol.toUpperCase())
      .slice(0, 7);

    const pairs: QueryPair[] = [];
    const coinGeckoIds = new Map<string, string>();
    let skippedNoEthereumAddress = 0;
    let skippedInvalidAddress = 0;

    for (const { item } of coins) {
      const ethPlatform = item.detail_platforms?.["ethereum"];
      // Use detailed platform data (includes decimal_place) first, fall back
      // to the coarser `platforms` map which only has the address.
      const ethAddress =
        ethPlatform?.contract_address ?? item.platforms?.["ethereum"];

      if (!ethAddress) {
        skippedNoEthereumAddress += 1;
        continue;
      }
      if (!ethAddress.startsWith("0x")) {
        skippedInvalidAddress += 1;
        continue;
      }

      // Skip if this is WETH itself
      if (ethAddress.toLowerCase() === WETH_DEF.address.toLowerCase()) continue;

      const symbol = item.symbol.toUpperCase();

      // Resolve decimals: prefer CoinGecko's detail_platforms value, fall back
      // to 18 only when the field is absent/null (most ERC-20s are 18-decimal).
      const decimals =
        typeof ethPlatform?.decimal_place === "number" &&
        ethPlatform.decimal_place > 0
          ? ethPlatform.decimal_place
          : 18;

      if (decimals !== 18) {
        logger.debug(
          `[Researcher] Trending token ${symbol} has non-standard decimals: ${decimals}`,
        );
      }

      const name = item.name;
      const amountIn = (10n ** BigInt(decimals)).toString();

      pairs.push({
        tokenIn: { address: ethAddress, symbol, name, decimals },
        tokenOut: {
          address: WETH_DEF.address,
          symbol: "WETH",
          name: "Wrapped Ether",
          decimals: WETH_DEF.decimals,
        },
        amountIn,
        priceLabel: `WETH per ${symbol}`,
      });

      // Record CoinGecko coin ID for market data lookup (fix: bypass static map)
      coinGeckoIds.set(symbol, item.id);

      logger.debug(
        `[Researcher] Trending pair queued: ${symbol} (${ethAddress.slice(0, 10)}…) decimals=${decimals} cgId=${item.id}`,
      );
    }

    if (pairs.length > 0) {
      logger.info(
        `[Researcher] ${pairs.length} trending token pair(s) added: ${pairs.map((p) => p.tokenIn.symbol).join(", ")}`,
      );
    }

    if (skippedNoEthereumAddress > 0 || skippedInvalidAddress > 0) {
      logger.info(
        `[Researcher] Trending tokens skipped for on-chain quoting: ` +
          `${skippedNoEthereumAddress} without Ethereum mainnet address, ` +
          `${skippedInvalidAddress} with invalid address format`,
      );
    }

    return { pairs, coinGeckoIds, trendingSymbols };
  } catch (err) {
    logger.warn(
      `[Researcher] fetchTrendingTokens error: ${err instanceof Error ? err.message : String(err)}`,
    );
    return empty;
  }
}

/** @deprecated Use fetchTrendingTokens() instead */
export async function fetchTrendingPairs(): Promise<QueryPair[]> {
  return (await fetchTrendingTokens()).pairs;
}
