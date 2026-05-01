import { COINGECKO_API_BASE_URL, logger } from "@swarm/shared";

import { SYMBOL_TO_TOKEN } from "../core/constants";
import type { CoinGeckoMarketData } from "../core/types";
import { normalizeAddress, normalizeSymbol } from "../utils";
import { buildCoinGeckoRequest } from "./coinGeckoClient";

/**
 * Fetches CoinGecko market data without any hardcoded ID map.
 *
 * - Registered tokens (present in SYMBOL_TO_TOKEN): queried by Ethereum contract
 *   address via /simple/token_price/ethereum — no ID mapping needed.
 * - Dynamic trending tokens supplied via extraIds (symbol → CoinGecko ID from the
 *   trending API): queried via /coins/markets?ids=…
 */
export async function fetchCoinGeckoMarketData(
  symbols: string[],
  extraIds?: Map<string, string>,
): Promise<Map<string, CoinGeckoMarketData>> {
  const { hasApiKey, authQuery, headers } = buildCoinGeckoRequest();
  const result = new Map<string, CoinGeckoMarketData>();

  if (!hasApiKey) {
    logger.debug(
      "[Researcher] No COINGECKO_API_KEY set - skipping market data",
    );
    return result;
  }

  // ── Path 1: registered tokens — query by contract address ────────────────
  const addressToSymbol = new Map<string, string>();
  for (const sym of symbols) {
    const normalizedSymbol = normalizeSymbol(sym);
    const def = SYMBOL_TO_TOKEN[normalizedSymbol];
    if (def)
      addressToSymbol.set(normalizeAddress(def.address), normalizedSymbol);
  }

  if (addressToSymbol.size > 0) {
    const addresses = Array.from(addressToSymbol.keys()).join(",");
    const url =
      `${COINGECKO_API_BASE_URL}/simple/token_price/ethereum` +
      `?contract_addresses=${addresses}&vs_currencies=usd` +
      `&include_market_cap=true&include_24hr_vol=true&include_24hr_change=true&${authQuery}`;
    try {
      const res = await fetch(url, { headers });
      if (res.ok) {
        const data = (await res.json()) as Record<
          string,
          {
            usd?: number;
            usd_market_cap?: number;
            usd_24h_vol?: number;
            usd_24h_change?: number;
          }
        >;
        for (const [address, prices] of Object.entries(data)) {
          const sym = addressToSymbol.get(normalizeAddress(address));
          if (!sym) continue;
          result.set(sym, {
            symbol: sym,
            price_usd: prices.usd ?? 0,
            market_cap_usd: prices.usd_market_cap ?? 0,
            volume_24h_usd: prices.usd_24h_vol ?? 0,
            price_change_24h_pct: prices.usd_24h_change ?? 0,
          });
          logger.debug(
            `[Researcher] CoinGecko ${sym}: $${prices.usd} vol=$${((prices.usd_24h_vol ?? 0) / 1e6).toFixed(1)}M`,
          );
        }
      } else {
        logger.warn(
          `[Researcher] CoinGecko token_price ${res.status}: ${await res.text()}`,
        );
      }
    } catch (err) {
      logger.warn(
        `[Researcher] CoinGecko token_price fetch error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ── Path 2: trending tokens with CoinGecko IDs — query by ID ─────────────
  if (extraIds && extraIds.size > 0) {
    const idToSymbol = new Map<string, string>();
    for (const [sym, id] of extraIds) {
      const normalizedSymbol = normalizeSymbol(sym);
      if (id && !result.has(normalizedSymbol)) {
        idToSymbol.set(id, normalizedSymbol);
      }
    }
    if (idToSymbol.size > 0) {
      const ids = Array.from(idToSymbol.keys()).join(",");
      const url =
        `${COINGECKO_API_BASE_URL}/coins/markets?vs_currency=usd&ids=${ids}` +
        `&order=market_cap_desc&per_page=50&page=1&price_change_percentage=24h&${authQuery}`;
      try {
        const res = await fetch(url, { headers });
        if (res.ok) {
          const coins = (await res.json()) as Array<{
            id: string;
            symbol: string;
            current_price: number;
            total_volume: number;
            price_change_percentage_24h: number;
            market_cap: number;
          }>;
          for (const coin of coins) {
            const sym = idToSymbol.get(coin.id);
            if (!sym) continue;
            result.set(sym, {
              symbol: sym,
              price_usd: coin.current_price,
              volume_24h_usd: coin.total_volume,
              price_change_24h_pct: coin.price_change_percentage_24h,
              market_cap_usd: coin.market_cap,
            });
          }
        }
      } catch (err) {
        logger.warn(
          `[Researcher] CoinGecko markets (trending) fetch error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  logger.info(
    `[Researcher] CoinGecko market data fetched for ${result.size} tokens`,
  );
  return result;
}
