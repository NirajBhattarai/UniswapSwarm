import { ZGCompute, type InferOptions } from "@swarm/compute";
import { BlackboardMemory } from "@swarm/memory";
import { logger, getConfig, isStablecoin } from "@swarm/shared";
import type {
  ResearchReport,
  TokenCandidate,
  WalletHolding,
} from "@swarm/shared";
import { Impit } from "impit";

import { SYMBOL_TO_TOKEN, SYSTEM_PROMPT } from "./core";
import {
  fetchCoinGeckoMarketData as fetchCoinGeckoMarketDataService,
  fetchDefiLlamaHistoricalChanges,
  fetchNarrativeSignal,
  fetchTrendingTokens,
} from "./services";
import {
  buildMarketDataText,
  buildNarrativeText,
  buildResearchPrompt,
  enrichCandidatesWithMarketData,
  filterCandidatesByLiquidity,
} from "./formatters";
import { normalizeSymbol, toChecksumSafe } from "./utils/index";
import type { CoinGeckoMarketData, PoolSnapshot } from "./core";
import { fetchWalletHoldingsAlchemy as fetchWalletHoldingsAlchemyService } from "./services/walletHoldings";

export type { CoinGeckoMarketData };

const WALLET_HOLDINGS_MEMORY_KEY = "researcher/wallet_holdings";

export class ResearchAgent {
  static readonly MEMORY_KEY = "researcher/report";
  readonly id = "researcher";
  readonly role = "Researcher";

  private readonly compute: ZGCompute;
  private readonly memory: BlackboardMemory;
  /** Spoofs Chrome TLS fingerprint + browser headers to bypass bot-detection (Reddit, etc.) */
  private readonly browser = new Impit({ browser: "chrome" });

  constructor(compute: ZGCompute, memory: BlackboardMemory) {
    this.compute = compute;
    this.memory = memory;
  }

  private buildResearchPromptInput(params: {
    goal: string;
    snapshots: PoolSnapshot[];
    marketData: Map<string, CoinGeckoMarketData>;
    narrativeSignal: import("./core").NarrativeSignal;
    walletHoldings?: WalletHolding[];
  }): string {
    const cfg = getConfig();
    return buildResearchPrompt({
      goal: params.goal,
      cfg,
      pools: params.snapshots,
      marketDataText: buildMarketDataText(params.marketData),
      narrativeText: buildNarrativeText(params.narrativeSignal),
      context: this.memory.contextFor(ResearchAgent.MEMORY_KEY),
      ...(params.walletHoldings
        ? { walletHoldings: params.walletHoldings }
        : {}),
    });
  }

  private finalizeReportMetadata(
    report: ResearchReport,
    walletHoldings?: WalletHolding[],
  ): void {
    report.timestamp = Date.now();
    report.dataSource = "uniswap-multi-protocol";
    if (walletHoldings) report.walletHoldings = walletHoldings;
  }

  /**
   * Researcher runs FIRST in the pipeline — before the Planner.
   * It builds a unified token feed, calls the LLM once, then post-validates.
   *
   * Flow:
   *   buildTokenFeed() → walletHoldings (optional) → LLM inference
   *   → postValidate → filterByLiquidity → memory.write
   */
  async run(
    goal: string,
    opts: InferOptions = {},
    walletAddress?: string,
  ): Promise<ResearchReport> {
    // ── 1. Single tool: build complete token feed ──────────────────────────
    const { snapshots, marketData, narrativeSignal } =
      await this.buildTokenFeed();

    // ── 2. Wallet holdings (optional) ─────────────────────────────────────
    let walletHoldings: WalletHolding[] | undefined;
    if (walletAddress) {
      try {
        walletHoldings = await this.fetchWalletHoldings(
          walletAddress,
          marketData,
        );
        await this.memory.write(
          WALLET_HOLDINGS_MEMORY_KEY,
          this.id,
          this.role,
          walletHoldings,
        );
        logger.info(
          `[Researcher] Wallet ${walletAddress}: ${walletHoldings.length} non-dust holding(s) found`,
        );
      } catch (err) {
        logger.warn(
          `[Researcher] Could not fetch wallet holdings: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // ── 3. LLM inference — LLM selects and ranks from the feed ────────────
    const cfg = getConfig();
    const userPrompt = this.buildResearchPromptInput({
      goal,
      snapshots,
      marketData,
      narrativeSignal,
      ...(walletHoldings ? { walletHoldings } : {}),
    });

    const report = await this.compute.inferJSON<ResearchReport>(
      SYSTEM_PROMPT,
      userPrompt,
      opts,
    );

    this.finalizeReportMetadata(report, walletHoldings);

    // ── 4. Post-validate and filter ────────────────────────────────────────
    enrichCandidatesWithMarketData(report.candidates, marketData);
    report.candidates = this.postValidateCandidates(
      report.candidates,
      snapshots,
      marketData,
    );
    report.candidates = filterCandidatesByLiquidity(
      report.candidates,
      cfg.MIN_LIQUIDITY_USD,
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

  /**
   * Builds a complete, unified token feed using CoinGecko as the sole price
   * and liquidity-proxy source. No Uniswap Trading API calls are made here —
   * those are reserved for when a swap is actually being executed (Strategy /
   * Executor agents).
   *
   * Flow:
   *   fetchTrendingTokens()                      — 1 CoinGecko call
   *   → parallel: CoinGecko market data           — 1–2 CoinGecko calls
   *              DeFi Llama historical changes    — 1 free call
   *              Narrative signal                 — Reddit + news scrape
   *   → build synthetic PoolSnapshot per token   — no external calls
   */
  private async buildTokenFeed(): Promise<{
    snapshots: PoolSnapshot[];
    marketData: Map<string, CoinGeckoMarketData>;
    narrativeSignal: import("./core").NarrativeSignal;
  }> {
    // Step 1 — trending tokens (one CoinGecko call; result feeds narrative de-dup)
    const trendingResult = await fetchTrendingTokens();
    const { coinGeckoIds: trendingCoinGeckoIds, trendingSymbols } =
      trendingResult;

    // Address map for DeFi Llama — full registry + any trending extras
    const addressBySymbol = new Map<string, string>(
      Object.entries(SYMBOL_TO_TOKEN).map(([sym, def]) => [sym, def.address]),
    );
    for (const pair of trendingResult.pairs) {
      const sym = normalizeSymbol(pair.tokenIn.symbol);
      if (!addressBySymbol.has(sym))
        addressBySymbol.set(sym, pair.tokenIn.address);
    }

    // Step 2 — three parallel calls (no Uniswap API)
    const [narrativeSignal, historicalChanges, marketData] = await Promise.all([
      // Pass prefetched trending symbols so narrativeSignal skips its own CoinGecko fetch
      fetchNarrativeSignal(this.browser, trendingSymbols),
      fetchDefiLlamaHistoricalChanges(addressBySymbol),
      fetchCoinGeckoMarketDataService(
        Object.keys(SYMBOL_TO_TOKEN),
        trendingCoinGeckoIds,
      ),
    ]);

    // Merge DeFi Llama 7d/30d changes into market data
    for (const [sym, hist] of historicalChanges) {
      const existing = marketData.get(sym);
      if (existing) {
        existing.price_change_7d_pct = hist.price_change_7d_pct;
        existing.price_change_30d_pct = hist.price_change_30d_pct;
      }
    }

    // Step 3 — build snapshots entirely from CoinGecko data
    // liquidityUSD = 0.5 % of market cap (conservative DEX liquidity proxy)
    const snapshots: PoolSnapshot[] = [];
    const addedSymbols = new Set<string>();
    const wethAddress = SYMBOL_TO_TOKEN["WETH"]?.address ?? "";

    const buildSnapshot = (
      sym: string,
      address: string,
      cg: CoinGeckoMarketData,
    ): PoolSnapshot => ({
      poolAddress: address, // placeholder — no pool queried at research time
      tokenAddress: address,
      tokenSymbol: sym,
      tokenName: sym,
      baseTokenSymbol: "WETH",
      baseTokenAddress: wethAddress,
      protocol: "synthetic",
      feePct: 0.3,
      priceLabel: `USD per ${sym}`,
      currentPrice: cg.price_usd ?? 0,
      virtualToken1: 0,
      liquidityUSD: Math.round((cg.market_cap_usd ?? 0) * 0.005),
      liquidityRaw: "0",
      tick: 0,
    });

    // Registry tokens
    for (const [sym, def] of Object.entries(SYMBOL_TO_TOKEN)) {
      if (isStablecoin({ symbol: sym, address: def.address })) continue;
      const cg = marketData.get(sym);
      if (!cg?.price_usd || cg.price_usd <= 0) continue;
      if (!cg.market_cap_usd || cg.market_cap_usd <= 0) continue;
      snapshots.push(buildSnapshot(sym, def.address, cg));
      addedSymbols.add(sym);
    }

    // Trending tokens not already in registry
    for (const pair of trendingResult.pairs) {
      const sym = normalizeSymbol(pair.tokenIn.symbol);
      if (addedSymbols.has(sym)) continue;
      const cg = marketData.get(sym);
      if (!cg?.price_usd || cg.price_usd <= 0) continue;
      snapshots.push(buildSnapshot(sym, pair.tokenIn.address, cg));
      addedSymbols.add(sym);
    }

    snapshots.sort((a, b) => b.liquidityUSD - a.liquidityUSD);
    logger.info(
      `[Researcher] Token feed ready: ${snapshots.length} tokens (CoinGecko-only) | narrative=${narrativeSignal.narrative} fearGreed=${narrativeSignal.fearGreedValue} trending=[${narrativeSignal.trendingTokens.join(",")}]`,
    );
    return { snapshots, marketData, narrativeSignal };
  }

  /**
   * Wallet holdings are Alchemy-only so we can discover all ERC-20 balances,
   * including tokens outside the local registry.
   */
  private async fetchWalletHoldings(
    walletAddress: string,
    marketData: Map<string, CoinGeckoMarketData>,
  ): Promise<WalletHolding[]> {
    const { ALCHEMY_API_KEY } = getConfig();
    if (!ALCHEMY_API_KEY) {
      throw new Error(
        "[Researcher] ALCHEMY_API_KEY is required for wallet holdings fetch",
      );
    }
    return fetchWalletHoldingsAlchemyService({
      walletAddress,
      marketData,
      alchemyKey: ALCHEMY_API_KEY,
    });
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
      const symbol = normalizeSymbol(pool.tokenSymbol);
      const existing = bestPoolBySymbol.get(symbol);
      if (!existing || pool.liquidityUSD > existing.liquidityUSD) {
        bestPoolBySymbol.set(symbol, pool);
      }
    }

    const validated: TokenCandidate[] = [];
    const seenSymbols = new Set<string>();
    let dropped = 0;

    for (const c of candidates) {
      const symbol = normalizeSymbol(c.symbol);

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
      const checksummedAddress = toChecksumSafe(canonicalAddress);

      const fixed: TokenCandidate = {
        ...c,
        symbol,
        address: checksummedAddress,
        name: pool.tokenName || c.name || symbol,
        pairAddress: toChecksumSafe(pool.poolAddress),
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
}
