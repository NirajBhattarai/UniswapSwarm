import { ZGCompute, type InferOptions } from "@swarm/compute";
import { BlackboardMemory } from "@swarm/memory";
import {
  logger,
  getConfig,
  UNISWAP,
  UNISWAP_TRADE_API_BASE_URL,
  isStablecoin,
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
  SYMBOL_TO_COINGECKO_ID,
  SYSTEM_PROMPT,
} from "./core";
import {
  fetchCoinGeckoMarketData as fetchCoinGeckoMarketDataService,
  fetchDefiLlamaHistoricalChanges,
  fetchNarrativeSignal,
  fetchOnChainPools,
  populateLiquidityUSD,
} from "./services";
import {
  buildMarketDataText,
  buildNarrativeText,
  buildResearchPrompt,
  enrichCandidatesWithMarketData,
  filterCandidatesByLiquidity,
} from "./formatters";
import type {
  TokenDef,
  CoinGeckoMarketData,
  TokenPriceResult,
  PriceQuoteResponse,
  PoolSnapshot,
} from "./core";

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
      `[Researcher] Fetching Uniswap multi-protocol pool data via Uniswap Trading API…`,
    );

    // Fetch pools first so we can reuse its CoinGecko trending list and avoid
    // a duplicate /search/trending API call inside narrativeSignal.
    const poolsResult = await fetchOnChainPools();
    const {
      snapshots: pools,
      trendingCoinGeckoIds,
      trendingSymbols,
    } = poolsResult;
    // Build address-by-symbol map for DeFi Llama from pool snapshots + known registry.
    // Done here so the DeFi Llama fetch can run in parallel with narrativeSignal.
    const addressBySymbol = new Map<string, string>();
    for (const pool of pools) {
      const sym = pool.tokenSymbol.toUpperCase();
      if (!addressBySymbol.has(sym)) {
        addressBySymbol.set(sym, pool.tokenAddress);
      }
    }
    for (const [sym, def] of Object.entries(SYMBOL_TO_TOKEN)) {
      if (!addressBySymbol.has(sym)) {
        addressBySymbol.set(sym, def.address);
      }
    }

    // Fetch narrative signal + DeFi Llama historical changes in parallel
    const [narrativeSignal, historicalChanges] = await Promise.all([
      fetchNarrativeSignal(this.browser, trendingSymbols),
      fetchDefiLlamaHistoricalChanges(addressBySymbol),
    ]);
    logger.info(
      `[Researcher] Fetched ${pools.length} pools | narrative=${narrativeSignal.narrative} fearGreed=${narrativeSignal.fearGreedValue} trending=[${narrativeSignal.trendingTokens.join(",")}] | DeFi Llama history=${historicalChanges.size} tokens`,
    );

    // Fetch market data for all known symbols + trending tokens (using live CoinGecko IDs
    // so we don't miss tokens absent from the static SYMBOL_TO_COINGECKO_ID map)
    const allSymbols = [
      ...Object.keys(SYMBOL_TO_COINGECKO_ID),
      ...narrativeSignal.extraSymbols,
    ];
    const marketData = await fetchCoinGeckoMarketDataService(
      allSymbols,
      trendingCoinGeckoIds,
    );

    // Merge DeFi Llama 7d/30d historical changes into market data
    for (const [sym, hist] of historicalChanges) {
      const existing = marketData.get(sym);
      if (existing) {
        existing.price_change_7d_pct = hist.price_change_7d_pct;
        existing.price_change_30d_pct = hist.price_change_30d_pct;
      }
    }

    // Populate liquidityUSD now that market cap data is available for sanity-capping.
    // Uniswap V3's L×√P formula inflates virtual reserves for concentrated positions;
    // capping at 2% of market cap keeps pool rankings meaningful.
    populateLiquidityUSD(pools, marketData);
    pools.sort((a, b) => b.liquidityUSD - a.liquidityUSD);

    const cfg = getConfig();
    const context = this.memory.contextFor(ResearchAgent.MEMORY_KEY);
    const marketDataText = buildMarketDataText(marketData);
    const narrativeText = buildNarrativeText(narrativeSignal);
    const userPrompt = buildResearchPrompt({
      goal,
      cfg,
      pools,
      marketDataText,
      narrativeText,
      context,
    });

    const report = await this.compute.inferJSON<ResearchReport>(
      SYSTEM_PROMPT,
      userPrompt,
      { maxTokens: 4096, ...opts },
    );

    report.timestamp = Date.now();
    report.dataSource = "uniswap-multi-protocol";

    enrichCandidatesWithMarketData(report.candidates, marketData);
    report.candidates = this.postValidateCandidates(
      report.candidates,
      pools,
      marketData,
    );
    report.candidates = filterCandidatesByLiquidity(
      report.candidates,
      cfg.MIN_LIQUIDITY_USD,
    );

    // Fallback: if the LLM returned fewer than 3 candidates, top up from the
    // highest-liquidity non-stablecoin pools that aren't already in the list.
    if (report.candidates.length < 3) {
      report.candidates = this.topUpCandidates(
        report.candidates,
        pools,
        marketData,
        cfg.MIN_LIQUIDITY_USD,
        3,
      );
    }

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

  /**
   * Post-validates LLM output against live pool snapshots + canonical token map.
   * This prevents symbol/address hallucinations in the final API response.
   */
  private postValidateCandidates(
    candidates: TokenCandidate[],
    pools: PoolSnapshot[],
    marketData: Map<string, CoinGeckoMarketData>,
  ): TokenCandidate[] {
    const bestPoolBySymbol = new Map<string, PoolSnapshot>();

    for (const pool of pools) {
      const symbol = pool.tokenSymbol.toUpperCase();
      const existing = bestPoolBySymbol.get(symbol);
      if (!existing || pool.liquidityUSD > existing.liquidityUSD) {
        bestPoolBySymbol.set(symbol, pool);
      }
    }

    const validated: TokenCandidate[] = [];
    const seenSymbols = new Set<string>();
    let dropped = 0;

    for (const c of candidates) {
      const symbol = c.symbol.toUpperCase();

      // Deduplicate — keep only the first occurrence of each symbol
      if (seenSymbols.has(symbol)) {
        dropped += 1;
        continue;
      }

      const pool = bestPoolBySymbol.get(symbol);

      // If we never quoted this symbol on-chain in this cycle, discard it.
      if (!pool) {
        dropped += 1;
        continue;
      }

      const canonicalAddress =
        SYMBOL_TO_TOKEN[symbol]?.address ?? pool.tokenAddress;
      const checksummedAddress = this.toChecksumSafe(canonicalAddress);

      const fixed: TokenCandidate = {
        ...c,
        symbol,
        address: checksummedAddress,
        name: pool.tokenName || c.name || symbol,
        pairAddress: this.toChecksumSafe(pool.poolAddress),
        baseToken: pool.baseTokenSymbol,
        poolFeeTier: pool.feePct,
        liquidityUSD: pool.liquidityUSD,
        txCount: Number.isFinite(c.txCount) ? c.txCount : 0,
      };

      if (!Number.isFinite(fixed.priceUSD) || fixed.priceUSD <= 0) {
        fixed.priceUSD = pool.currentPrice;
      }

      const cg = marketData.get(symbol);
      if (cg) {
        fixed.volume24hUSD = cg.volume_24h_usd;
        fixed.priceChange24hPct = cg.price_change_24h_pct;
      }

      validated.push(fixed);
      seenSymbols.add(symbol);
    }

    if (dropped > 0) {
      logger.info(
        `[Researcher] Post-validation dropped ${dropped} hallucinated/unknown candidate(s)`,
      );
    }

    return validated;
  }

  /**
   * Top-up candidates to `target` count using the highest-liquidity non-stablecoin
   * pools not already present in the current candidate list.
   */
  private topUpCandidates(
    existing: TokenCandidate[],
    pools: PoolSnapshot[],
    marketData: Map<string, CoinGeckoMarketData>,
    minLiquidityUSD: number,
    target: number,
  ): TokenCandidate[] {
    if (existing.length >= target) return existing;

    const seenSymbols = new Set(existing.map((c) => c.symbol.toUpperCase()));
    const sorted = [...pools]
      .filter(
        (p) =>
          p.liquidityUSD >= minLiquidityUSD &&
          !isStablecoin({ symbol: p.tokenSymbol, address: p.tokenAddress }),
      )
      .sort((a, b) => b.liquidityUSD - a.liquidityUSD);

    const filled = [...existing];
    for (const pool of sorted) {
      if (filled.length >= target) break;
      const sym = pool.tokenSymbol.toUpperCase();
      if (seenSymbols.has(sym)) continue;
      seenSymbols.add(sym);

      const cg = marketData.get(sym);
      filled.push({
        address: this.toChecksumSafe(
          SYMBOL_TO_TOKEN[sym]?.address ?? pool.tokenAddress,
        ),
        symbol: sym,
        name: pool.tokenName || sym,
        pairAddress: this.toChecksumSafe(pool.poolAddress),
        baseToken: pool.baseTokenSymbol,
        priceUSD: cg?.price_usd ?? pool.currentPrice,
        liquidityUSD: pool.liquidityUSD,
        volume24hUSD: cg?.volume_24h_usd ?? 0,
        priceChange24hPct: cg?.price_change_24h_pct ?? 0,
        poolFeeTier: pool.feePct,
        txCount: 0,
      });
    }

    if (filled.length > existing.length) {
      logger.info(
        `[Researcher] Topped up candidates from ${existing.length} → ${filled.length} (fallback pools)`,
      );
    }

    return filled;
  }

  private toChecksumSafe(address: string): string {
    try {
      return ethers.getAddress(address);
    } catch {
      return address;
    }
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
      fetchCoinGeckoMarketDataService(ordered),
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

  // ── Public: fetch CoinGecko market data for symbols ─────────────────────────
  // Used by the orchestrator market endpoint.
  async fetchCoinGeckoMarketData(
    symbols: string[],
  ): Promise<Map<string, CoinGeckoMarketData>> {
    return fetchCoinGeckoMarketDataService(symbols);
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

        // Determine token ordering (lower address = token0 in concentrated-liquidity pools)
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
