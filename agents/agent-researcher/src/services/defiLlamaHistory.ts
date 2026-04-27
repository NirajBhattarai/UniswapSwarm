import { logger } from "@swarm/shared";

const DEFILLAMA_COINS_BASE = "https://coins.llama.fi";

export interface DefiLlamaHistoricalData {
  price_change_7d_pct: number | null;
  price_change_30d_pct: number | null;
}

/**
 * Fetches 7-day and 30-day price change percentages from the FREE DeFi Llama
 * coins API — no API key required.
 *
 * Endpoint: GET https://coins.llama.fi/percentage/{coins}?period=7d|30d
 * Coin key format: `ethereum:0x<address>` (lower-case)
 *
 * Both periods are fetched in parallel, then merged by symbol.
 *
 * @param addressBySymbol  Map of UPPER_SYMBOL → Ethereum mainnet address
 * @returns Map of UPPER_SYMBOL → { price_change_7d_pct, price_change_30d_pct }
 */
export async function fetchDefiLlamaHistoricalChanges(
  addressBySymbol: Map<string, string>,
): Promise<Map<string, DefiLlamaHistoricalData>> {
  const result = new Map<string, DefiLlamaHistoricalData>();

  if (addressBySymbol.size === 0) return result;

  // Build ethereum:0x... → SYMBOL reverse-lookup and the query string
  const keyToSymbol = new Map<string, string>();
  const coinKeys: string[] = [];

  for (const [symbol, address] of addressBySymbol) {
    const key = `ethereum:${address.toLowerCase()}`;
    coinKeys.push(key);
    keyToSymbol.set(key, symbol.toUpperCase());
  }

  const coinsParam = encodeURIComponent(coinKeys.join(","));

  try {
    const [res7d, res30d] = await Promise.all([
      fetch(
        `${DEFILLAMA_COINS_BASE}/percentage/${coinsParam}?period=7d&searchWidth=600`,
        { headers: { Accept: "application/json" } },
      ),
      fetch(
        `${DEFILLAMA_COINS_BASE}/percentage/${coinsParam}?period=30d&searchWidth=600`,
        { headers: { Accept: "application/json" } },
      ),
    ]);

    type LlamaResp = { coins: Record<string, number> };
    const empty: LlamaResp = { coins: {} };

    const [json7d, json30d] = await Promise.all([
      res7d.ok ? (res7d.json() as Promise<LlamaResp>) : Promise.resolve(empty),
      res30d.ok
        ? (res30d.json() as Promise<LlamaResp>)
        : Promise.resolve(empty),
    ]);

    if (!res7d.ok) {
      logger.warn(`[Researcher] DeFi Llama 7d response: ${res7d.status}`);
    }
    if (!res30d.ok) {
      logger.warn(`[Researcher] DeFi Llama 30d response: ${res30d.status}`);
    }

    // Merge both periods into the result map keyed by symbol
    for (const [key, sym] of keyToSymbol) {
      const c7d = json7d.coins[key];
      const c30d = json30d.coins[key];

      // Only emit an entry when at least one period has data
      if (c7d !== undefined || c30d !== undefined) {
        result.set(sym, {
          price_change_7d_pct: c7d ?? null,
          price_change_30d_pct: c30d ?? null,
        });
        logger.debug(
          `[Researcher] DeFi Llama ${sym}: 7d=${c7d?.toFixed(2) ?? "n/a"}% 30d=${c30d?.toFixed(2) ?? "n/a"}%`,
        );
      }
    }

    logger.info(
      `[Researcher] DeFi Llama historical price changes fetched for ${result.size}/${addressBySymbol.size} tokens`,
    );
  } catch (err) {
    logger.warn(
      `[Researcher] DeFi Llama fetch error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return result;
}
