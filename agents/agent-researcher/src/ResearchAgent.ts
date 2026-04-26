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
import { Impit } from "impit";

import {
  POOL_ABI,
  QUOTER_V2_ABI,
  FACTORY_ABI,
  ERC20_META_ABI,
  SYMBOL_TO_TOKEN,
  ADDRESS_TO_SYMBOL,
  USDC_DEF,
  WETH_DEF,
  FEE_TIERS,
  MIN_POOL_LIQUIDITY_USD,
  QUOTE_SWAPPER_ADDRESS,
  QUERY_PAIRS,
  SYMBOL_TO_COINGECKO_ID,
  NARRATIVE_KEYWORDS,
  NARRATIVE_EXTRA_SYMBOLS,
} from "./constants";
import { SYSTEM_PROMPT } from "./prompts";
import type {
  TokenDef,
  UniswapAPIQuoteResponse,
  PoolSnapshot,
  NarrativeType,
  NarrativeSignal,
  CoinGeckoMarketData,
  TokenPriceResult,
  PriceQuoteResponse,
} from "./types";

export type { TokenPriceResult, PriceQuoteResponse, CoinGeckoMarketData };

export class ResearchAgent {
  static readonly MEMORY_KEY = "researcher/report";
  readonly id = "researcher";
  readonly role = "Researcher";

  private readonly compute: ZGCompute;
  private readonly memory: BlackboardMemory;
  /** Spoofs Chrome TLS fingerprint + browser headers to bypass bot-detection (Reddit, etc.) */
  private readonly browser = new Impit({ browser: "chrome" });

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
    logger.info(
      `[Researcher] Fetching Uniswap V3 pool data via Uniswap Trading API…`,
    );

    // Fetch pools, CoinGecko base data, and narrative signal all in parallel
    const [pools, narrativeSignal] = await Promise.all([
      this.fetchOnChainPools(),
      this.fetchNarrativeSignal(),
    ]);
    logger.info(
      `[Researcher] Fetched ${pools.length} pools | narrative=${narrativeSignal.narrative} fearGreed=${narrativeSignal.fearGreedValue} trending=[${narrativeSignal.trendingTokens.join(",")}]`,
    );

    // Fetch market data for base symbols + narrative-relevant extras
    const allSymbols = [
      ...Object.keys(SYMBOL_TO_COINGECKO_ID),
      ...narrativeSignal.extraSymbols,
    ];
    const marketData = await this.fetchCoinGeckoMarketData(allSymbols);

    const cfg = getConfig();
    const context = this.memory.contextFor(ResearchAgent.MEMORY_KEY);

    // Build a compact market summary string from CoinGecko data (if available)
    let marketDataText = "";
    if (marketData.size > 0) {
      const lines = Array.from(marketData.entries()).map(
        ([sym, d]) =>
          `${sym}: price=$${(d.price_usd ?? 0).toFixed(4)} vol24h=$${((d.volume_24h_usd ?? 0) / 1e6).toFixed(1)}M chg24h=${(d.price_change_24h_pct ?? 0).toFixed(2)}% mcap=$${((d.market_cap_usd ?? 0) / 1e9).toFixed(2)}B`,
      );
      marketDataText = `\nLive CoinGecko market data (24h):\n${lines.join("\n")}`;
    }

    // Build narrative signal section for LLM context
    const narrativeText = [
      `Market Sentiment (Fear & Greed Index): ${narrativeSignal.fearGreedValue}/100 — "${narrativeSignal.fearGreedLabel}"`,
      `Detected Narrative: ${narrativeSignal.narrative}`,
      narrativeSignal.trendingTokens.length > 0
        ? `CoinGecko Trending Tokens (right now): ${narrativeSignal.trendingTokens.join(", ")}`
        : null,
      narrativeSignal.topHeadlines.length > 0
        ? `Recent News & Community Headlines:\n${narrativeSignal.topHeadlines.map((h) => `  • ${h}`).join("\n")}`
        : null,
    ]
      .filter(Boolean)
      .join("\n");

    const userPrompt = [
      `Trading goal: ${goal}`,
      `Default constraints: maxSlippage=${cfg.MAX_SLIPPAGE_PCT}%, maxPosition=$${cfg.MAX_POSITION_USDC} USDC, minLiquidity=$${cfg.MIN_LIQUIDITY_USD.toLocaleString()}`,
      `Live Uniswap multi-protocol pool data (V2/V3/V4/UniswapX) — each entry has a pre-computed \`tokenAddress\` — use it directly as the candidate \`address\` field:\n${JSON.stringify(pools, null, 2)}`,
      marketDataText,
      `\nReal-time narrative signal:\n${narrativeText}`,
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
    report.dataSource = "uniswap-multi-protocol";

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
              protocols: ["V2", "V3", "V4", "UNISWAPX_V2"],
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
          // Accept v2-pool, v3-pool, v4-pool — skip mixed/unknown types
          if (!pool.type.endsWith("-pool")) return;

          const inputAmt = Number(data.quote.input.amount);
          const outputAmt = Number(data.quote.output.amount);

          // currentPrice = human-unit output per human-unit input (e.g. 3200 USDC per WETH)
          const currentPrice =
            outputAmt /
            10 ** pair.tokenOut.decimals /
            (inputAmt / 10 ** pair.tokenIn.decimals);

          // Determine which side is token0 (lower address) — needed for sqrtPrice direction
          const inLow = pair.tokenIn.address.toLowerCase();
          const outLow = pair.tokenOut.address.toLowerCase();
          const [, t1] =
            inLow < outLow
              ? [pair.tokenIn, pair.tokenOut]
              : [pair.tokenOut, pair.tokenIn];

          // virtualToken1 ≈ L × sqrtPrice / 2^96 (in token1 human units)
          // V2 pools don't have sqrtRatioX96/liquidity — fall back to 0
          const sqrtRaw = pool.sqrtRatioX96 ?? "0";
          const liquidityRaw = pool.liquidity ?? "0";
          const sqrtPriceNum =
            sqrtRaw !== "0" ? Number(BigInt(sqrtRaw)) / Number(2n ** 96n) : 0;
          const virtualToken1Raw =
            liquidityRaw !== "0"
              ? Number(BigInt(liquidityRaw)) * sqrtPriceNum
              : 0;
          const virtualToken1 = virtualToken1Raw / 10 ** t1.decimals;

          // Identify which token is the trade token vs the base token.
          // The base is whichever side is WETH, USDC, USDT, or DAI.
          const BASE_SYMBOLS = new Set(["WETH", "USDC", "USDT", "DAI"]);
          const isInBase = BASE_SYMBOLS.has(pair.tokenIn.symbol);
          const tradeTok = isInBase ? pair.tokenOut : pair.tokenIn;
          const baseTok = isInBase ? pair.tokenIn : pair.tokenOut;

          snapshots.push({
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
            liquidityUSD: 0, // filled in post-processing below
            liquidityRaw: liquidityRaw,
            tick: pool.tick ?? 0,
          });

          logger.debug(
            `[Researcher] ${pair.priceLabel}: ${currentPrice.toFixed(4)} ` +
              `(${pool.type} ${pool.address}, fee ${pool.fee})`,
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
        (s.tokenSymbol === "WETH" && stableSymbols.has(s.baseTokenSymbol)) ||
        (s.baseTokenSymbol === "WETH" && stableSymbols.has(s.tokenSymbol))
      ) {
        if (stableSymbols.has(s.baseTokenSymbol)) {
          wethUSD = s.currentPrice;
        } else {
          wethUSD = 1 / s.currentPrice;
        }
        if (wethUSD > 100 && wethUSD < 1_000_000) break; // sanity
      }
    }
    if (wethUSD === 0) wethUSD = 3_000; // safe fallback if no WETH/stable pair fetched
    logger.debug(
      `[Researcher] WETH/USD reference price: $${wethUSD.toFixed(2)}`,
    );

    for (const s of snapshots) {
      // virtualToken1 is in baseToken human units. Price the base side, double for both sides.
      const baseSymbol = s.baseTokenSymbol;
      let basePriceUSD: number;
      if (stableSymbols.has(baseSymbol)) {
        basePriceUSD = 1; // USDC / USDT / DAI ≈ $1
      } else if (baseSymbol === "WETH") {
        basePriceUSD = wethUSD;
      } else {
        basePriceUSD = 0; // unknown — skip
      }
      s.liquidityUSD =
        basePriceUSD > 0 ? Math.round(s.virtualToken1 * basePriceUSD * 2) : 0;
      logger.debug(
        `[Researcher] ${s.tokenSymbol}/${s.baseTokenSymbol} (${s.protocol}) liquidityUSD=$${s.liquidityUSD.toLocaleString()}`,
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

  // ── Narrative signal: Reddit + CoinTelegraph RSS + CoinGecko trending + Fear&Greed ──

  /**
   * Aggregates market sentiment from four free external sources:
   *  1. Alternative.me Fear & Greed index
   *  2. CoinGecko /search/trending
   *  3. Reddit r/CryptoCurrency hot posts
   *  4. CoinTelegraph RSS feed
   *
   * Detects the dominant narrative from combined headlines, builds extra symbol list.
   */
  private async fetchNarrativeSignal(): Promise<NarrativeSignal> {
    const [fearGreed, trending, redditTitles, newsTitles] = await Promise.all([
      this.fetchFearGreed(),
      this.fetchCoinGeckoTrending(),
      this.fetchRedditPosts(),
      this.fetchCoinTelegraphRSS(),
    ]);

    const allTitles = [...redditTitles, ...newsTitles];
    const lowered = allTitles.map((t) => t.toLowerCase());

    // Score each narrative by counting keyword hits across all headlines
    const scores: Record<string, number> = {};
    for (const [name, keywords] of Object.entries(NARRATIVE_KEYWORDS)) {
      if (name === "neutral") continue;
      scores[name] = lowered.reduce((acc, title) => {
        const hits = keywords.filter((kw) => title.includes(kw)).length;
        return acc + hits;
      }, 0);
    }

    // Override to safe_haven when fear is extreme regardless of headline scores
    let winnerNarrative: NarrativeType = "neutral";
    if (fearGreed.score < 25) {
      winnerNarrative = "safe_haven";
    } else {
      const [topName, topScore] = Object.entries(scores).sort(
        ([, a], [, b]) => b - a,
      )[0] ?? ["neutral", 0];
      if (topScore > 0) winnerNarrative = topName as NarrativeType;
    }

    // Collect the top 5 headlines matching the winning narrative keywords
    const matchingKws = NARRATIVE_KEYWORDS[winnerNarrative] ?? [];
    const topHeadlines = allTitles
      .filter((t) => matchingKws.some((kw) => t.toLowerCase().includes(kw)))
      .slice(0, 5);
    const finalHeadlines =
      topHeadlines.length > 0 ? topHeadlines : allTitles.slice(0, 5);

    return {
      narrative: winnerNarrative,
      score: scores[winnerNarrative] ?? 0,
      topHeadlines: finalHeadlines,
      trendingTokens: trending,
      fearGreedValue: fearGreed.score,
      fearGreedLabel: fearGreed.label,
      extraSymbols: NARRATIVE_EXTRA_SYMBOLS[winnerNarrative] ?? [],
    };
  }

  /** GET https://api.alternative.me/fng/ — zero auth required */
  private async fetchFearGreed(): Promise<{ score: number; label: string }> {
    try {
      const res = await this.browser.fetch(
        "https://api.alternative.me/fng/?limit=1",
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as {
        data?: Array<{ value: string; value_classification: string }>;
      };
      const item = json.data?.[0];
      return item
        ? { score: Number(item.value), label: item.value_classification }
        : { score: 50, label: "Neutral" };
    } catch (err) {
      logger.warn(`[Researcher] fetchFearGreed failed: ${err}`);
      return { score: 50, label: "Neutral" };
    }
  }

  /** GET /search/trending — returns top 7 trending symbols from CoinGecko */
  private async fetchCoinGeckoTrending(): Promise<string[]> {
    try {
      const url = `${COINGECKO_API_BASE_URL}/search/trending`;
      const { COINGECKO_API_KEY } = getConfig();
      const headers: Record<string, string> = { Accept: "application/json" };
      if (COINGECKO_API_KEY) headers["x-cg-demo-api-key"] = COINGECKO_API_KEY;

      const res = await this.browser.fetch(url, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as {
        coins?: Array<{ item: { symbol: string } }>;
      };
      return (json.coins ?? [])
        .slice(0, 7)
        .map((c) => c.item.symbol.toUpperCase());
    } catch (err) {
      logger.warn(`[Researcher] fetchCoinGeckoTrending failed: ${err}`);
      return [];
    }
  }

  /** GET https://www.reddit.com/r/CryptoCurrency/hot.rss — JSON API is blocked; RSS is open */
  private async fetchRedditPosts(): Promise<string[]> {
    try {
      const res = await this.browser.fetch(
        "https://www.reddit.com/r/CryptoCurrency/hot.rss?limit=25",
        { headers: { Accept: "application/rss+xml, application/xml" } },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const xml = await res.text();
      const titles = [...xml.matchAll(/<title>([^<]{10,300})<\/title>/g)]
        .map((m) =>
          (m[1] ?? "")
            .trim()
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">"),
        )
        .filter(Boolean)
        .slice(1, 21);
      return titles;
    } catch (err) {
      logger.warn(`[Researcher] fetchRedditPosts failed: ${err}`);
      return [];
    }
  }

  /** GET https://cointelegraph.com/rss — parse <title> tags from XML */
  private async fetchCoinTelegraphRSS(): Promise<string[]> {
    try {
      const res = await this.browser.fetch("https://cointelegraph.com/rss", {
        headers: { Accept: "application/rss+xml, application/xml, text/xml" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const xml = await res.text();
      // CDATA-wrapped titles (most CT articles)
      const cdataRe = /<title><!\[CDATA\[(.+?)\]\]><\/title>/gs;
      const cdataMatches = [...xml.matchAll(cdataRe)];
      if (cdataMatches.length > 0) {
        return cdataMatches
          .map((m) => (m[1] ?? "").trim())
          .filter(Boolean)
          .slice(1, 21);
      }
      // Fallback: plain <title>…</title>
      const plainRe = /<title>([^<]{3,200})<\/title>/g;
      const plain = [...xml.matchAll(plainRe)];
      return plain
        .map((m) => (m[1] ?? "").trim())
        .filter(Boolean)
        .slice(1, 21);
    } catch (err) {
      logger.warn(`[Researcher] fetchCoinTelegraphRSS failed: ${err}`);
      return [];
    }
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
