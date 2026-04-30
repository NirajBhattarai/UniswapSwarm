import { COINGECKO_API_BASE_URL, getConfig, logger } from "@swarm/shared";

type GoalFocus = "l2" | "ai" | "defi" | "staking" | "safe_haven";

type CoinGeckoMarketCoin = {
  symbol: string;
};

type CoinGeckoSearchResponse = {
  coins?: Array<{ symbol: string }>;
};

const GOAL_FOCUS_CATEGORY: Partial<Record<GoalFocus, string>> = {
  l2: "layer-2",
  defi: "decentralized-finance-defi",
  staking: "liquid-staking-tokens",
  safe_haven: "wrapped-tokens",
};

const GOAL_FOCUS_SEARCH_QUERY: Record<GoalFocus, string> = {
  l2: "layer 2",
  ai: "artificial intelligence",
  defi: "defi",
  staking: "liquid staking",
  safe_haven: "bitcoin",
};

export async function fetchGoalFocusSymbols(
  focus: GoalFocus,
): Promise<string[]> {
  const { COINGECKO_API_KEY } = getConfig();
  if (!COINGECKO_API_KEY) return [];

  const symbols = new Set<string>();
  const keyQuery = `x_cg_demo_api_key=${encodeURIComponent(COINGECKO_API_KEY)}`;
  const headers = { Accept: "application/json" };

  const category = GOAL_FOCUS_CATEGORY[focus];
  if (category) {
    try {
      const url =
        `${COINGECKO_API_BASE_URL}/coins/markets?vs_currency=usd` +
        `&category=${encodeURIComponent(category)}&order=market_cap_desc&per_page=20&page=1&${keyQuery}`;
      const res = await fetch(url, { headers });
      if (res.ok) {
        const data = (await res.json()) as CoinGeckoMarketCoin[];
        for (const coin of data) {
          const s = (coin.symbol ?? "").toUpperCase().trim();
          if (s) symbols.add(s);
        }
      }
    } catch (err) {
      logger.debug(
        `[Researcher] Goal focus category fetch failed (${focus}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  try {
    const query = GOAL_FOCUS_SEARCH_QUERY[focus];
    const url = `${COINGECKO_API_BASE_URL}/search?query=${encodeURIComponent(query)}&${keyQuery}`;
    const res = await fetch(url, { headers });
    if (res.ok) {
      const data = (await res.json()) as CoinGeckoSearchResponse;
      for (const coin of data.coins ?? []) {
        const s = (coin.symbol ?? "").toUpperCase().trim();
        if (s) symbols.add(s);
      }
    }
  } catch (err) {
    logger.debug(
      `[Researcher] Goal focus search fetch failed (${focus}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const out = Array.from(symbols)
    .filter((s) => s.length >= 2 && s.length <= 10)
    .slice(0, 30);
  if (out.length > 0) {
    logger.info(
      `[Researcher] Goal focus=${focus}: discovered ${out.length} symbols from CoinGecko`,
    );
  }
  return out;
}
