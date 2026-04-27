import { COINGECKO_API_BASE_URL, getConfig, logger } from "@swarm/shared";

import { SYMBOL_TO_COINGECKO_ID } from "../core/constants";
import type { CoinGeckoMarketData } from "../core/types";

/**
 * @param symbols  Token symbols to look up via the static SYMBOL_TO_COINGECKO_ID map
 * @param extraIds Additional symbol→coinGeckoId mappings for dynamically discovered tokens
 *                 (e.g. live-trending tokens whose IDs are returned by the CoinGecko trending API)
 */
export async function fetchCoinGeckoMarketData(
  symbols: string[],
  extraIds?: Map<string, string>,
): Promise<Map<string, CoinGeckoMarketData>> {
  const { COINGECKO_API_KEY } = getConfig();
  const result = new Map<string, CoinGeckoMarketData>();

  if (!COINGECKO_API_KEY) {
    logger.debug(
      "[Researcher] No COINGECKO_API_KEY set - skipping market data",
    );
    return result;
  }

  // id → symbol(s) mapping — start with statically known tokens
  const idToSymbols = new Map<string, string[]>();
  for (const sym of symbols) {
    const id = SYMBOL_TO_COINGECKO_ID[sym.toUpperCase()];
    if (!id) continue;
    const existing = idToSymbols.get(id) ?? [];
    existing.push(sym.toUpperCase());
    idToSymbols.set(id, existing);
  }

  // Merge dynamic IDs (from live trending) so those tokens get market data
  if (extraIds) {
    for (const [sym, id] of extraIds) {
      if (!id) continue;
      const existing = idToSymbols.get(id) ?? [];
      if (!existing.includes(sym.toUpperCase())) {
        existing.push(sym.toUpperCase());
      }
      idToSymbols.set(id, existing);
    }
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
