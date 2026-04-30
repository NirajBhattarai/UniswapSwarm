import { ZGCompute, type InferOptions } from "@swarm/compute";
import { BlackboardMemory } from "@swarm/memory";
import {
  logger,
  getConfig,
  UNISWAP,
  UNISWAP_TRADE_API_BASE_URL,
  isStablecoin,
} from "@swarm/shared";
import type {
  ResearchReport,
  TokenCandidate,
  WalletHolding,
} from "@swarm/shared";
import { ethers } from "ethers";
import { Impit } from "impit";

import {
  POOL_ABI,
  QUOTER_V2_ABI,
  FACTORY_ABI,
  ERC20_META_ABI,
  MULTICALL3_ADDRESS,
  MULTICALL3_ABI,
  ERC20_BALANCE_IFACE_ABI,
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
  fetchGoalFocusSymbols,
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
   *
   * @param walletAddress Optional Ethereum address — when provided, the agent fetches
   *                      all ERC-20 + native ETH balances for the wallet, enriches
   *                      each holding with USD value, and advises on each position.
   */
  async run(
    goal: string,
    opts: InferOptions = {},
    walletAddress?: string,
  ): Promise<ResearchReport> {
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

    // Fetch wallet holdings when a wallet address is provided.
    // This runs after marketData is ready so we can price each holding.
    let walletHoldings: WalletHolding[] | undefined;
    if (walletAddress) {
      try {
        walletHoldings = await this.fetchWalletHoldings(
          walletAddress,
          marketData,
        );
        // Persist holdings to shared memory so Strategy / Critic can read them.
        await this.memory.write(
          "researcher/wallet_holdings",
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

    const userPrompt = buildResearchPrompt({
      goal,
      cfg,
      pools,
      marketDataText,
      narrativeText,
      context,
      ...(walletHoldings ? { walletHoldings } : {}),
    });

    const report = await this.compute.inferJSON<ResearchReport>(
      SYSTEM_PROMPT,
      userPrompt,
      { maxTokens: 4096, ...opts },
    );

    report.timestamp = Date.now();
    report.dataSource = "uniswap-multi-protocol";

    // Attach on-chain holdings to the report (authoritative — not LLM-generated)
    if (walletHoldings) {
      report.walletHoldings = walletHoldings;
    }

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

    const goalFocus = this.detectGoalFocus(goal);
    const focusSymbolsDynamic = goalFocus
      ? await fetchGoalFocusSymbols(goalFocus)
      : [];
    report.candidates = this.applyGoalAwareOrdering(
      report.candidates,
      pools,
      marketData,
      cfg.MIN_LIQUIDITY_USD,
      goalFocus,
      focusSymbolsDynamic,
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
   * Dispatches to the Alchemy path if `ALCHEMY_API_KEY` is configured, otherwise
   * falls back to Multicall3. Alchemy is preferred because it auto-discovers every
   * ERC-20 the wallet holds — not just the tokens in the hardcoded registry.
   */
  private async fetchWalletHoldings(
    walletAddress: string,
    marketData: Map<string, CoinGeckoMarketData>,
  ): Promise<WalletHolding[]> {
    const { ALCHEMY_API_KEY } = getConfig();
    if (ALCHEMY_API_KEY) {
      return this.fetchWalletHoldingsAlchemy(
        walletAddress,
        marketData,
        ALCHEMY_API_KEY,
      );
    }
    return this.fetchWalletHoldingsMulticall(walletAddress, marketData);
  }

  /**
   * Alchemy path — two HTTP round-trips maximum:
   *  1. Batch `[eth_getBalance, alchemy_getTokenBalances("erc20")]` → all non-zero balances
   *  2. Batch `alchemy_getTokenMetadata` for any tokens not in the local registry
   *
   * This discovers ALL ERC-20 tokens the wallet holds, including ones absent from
   * the hardcoded SYMBOL_TO_TOKEN list.
   */
  private async fetchWalletHoldingsAlchemy(
    walletAddress: string,
    marketData: Map<string, CoinGeckoMarketData>,
    alchemyKey: string,
  ): Promise<WalletHolding[]> {
    const rpcUrl = `https://eth-mainnet.g.alchemy.com/v2/${alchemyKey}`;

    // ── Round-trip 1: ETH balance + all ERC-20 balances ─────────────────────
    const batchBody = [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getBalance",
        params: [walletAddress, "latest"],
      },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "alchemy_getTokenBalances",
        params: [walletAddress, "erc20"],
      },
    ];

    const batchResp = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(batchBody),
    });
    if (!batchResp.ok) {
      throw new Error(`Alchemy batch RPC failed: HTTP ${batchResp.status}`);
    }

    const batchData = (await batchResp.json()) as Array<{
      id: number;
      result?: unknown;
      error?: { message: string };
    }>;

    const ethHex = batchData.find((r) => r.id === 1)?.result as
      | string
      | undefined;
    const tokenBalancesResult = batchData.find((r) => r.id === 2)?.result as
      | {
          tokenBalances: Array<{
            contractAddress: string;
            tokenBalance: string | null;
          }>;
        }
      | undefined;

    const holdings: WalletHolding[] = [];

    // ── Native ETH ───────────────────────────────────────────────────────────
    if (ethHex) {
      const ethFormatted = parseFloat(ethers.formatEther(BigInt(ethHex)));
      const ethPrice =
        marketData.get("WETH")?.price_usd ??
        marketData.get("ETH")?.price_usd ??
        0;
      if (ethFormatted > 0.0001) {
        holdings.push({
          symbol: "ETH",
          address: "ETH",
          decimals: 18,
          balanceFormatted: ethFormatted,
          priceUSD: ethPrice,
          valueUSD: ethFormatted * ethPrice,
        });
      }
    }

    // ── ERC-20 tokens ────────────────────────────────────────────────────────
    // Filter out zero balances (Alchemy returns all known tokens, even empty ones)
    const ZERO_BALANCE =
      "0x0000000000000000000000000000000000000000000000000000000000000000";
    const nonZero = (tokenBalancesResult?.tokenBalances ?? []).filter(
      (t) => t.tokenBalance && t.tokenBalance !== ZERO_BALANCE,
    );

    // Build address→{symbol,decimals} lookup from local registry (fast path)
    const addrToKnown = new Map<string, { symbol: string; decimals: number }>();
    for (const [sym, def] of Object.entries(SYMBOL_TO_TOKEN)) {
      addrToKnown.set(def.address.toLowerCase(), {
        symbol: sym,
        decimals: def.decimals,
      });
    }

    type TokenEntry = {
      contractAddress: string;
      tokenBalance: string;
      symbol: string;
      decimals: number;
    };

    const knownEntries: TokenEntry[] = [];
    const unknownAddresses: string[] = [];

    for (const t of nonZero) {
      const known = addrToKnown.get(t.contractAddress.toLowerCase());
      if (known) {
        knownEntries.push({
          contractAddress: t.contractAddress,
          tokenBalance: t.tokenBalance!,
          symbol: known.symbol,
          decimals: known.decimals,
        });
      } else {
        unknownAddresses.push(t.contractAddress);
      }
    }

    // ── Round-trip 2 (optional): metadata for tokens not in local registry ───
    const metaMap = new Map<string, { symbol: string; decimals: number }>();
    if (unknownAddresses.length > 0) {
      const metaBatch = unknownAddresses.map((addr, i) => ({
        jsonrpc: "2.0",
        id: i + 1,
        method: "alchemy_getTokenMetadata",
        params: [addr],
      }));
      const metaResp = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(metaBatch),
      });
      if (metaResp.ok) {
        const metaData = (await metaResp.json()) as Array<{
          id: number;
          result?: { symbol?: string | null; decimals?: number | null };
        }>;
        for (let i = 0; i < unknownAddresses.length; i++) {
          const meta = metaData.find((m) => m.id === i + 1)?.result;
          if (meta?.symbol && meta?.decimals != null) {
            metaMap.set(unknownAddresses[i]!.toLowerCase(), {
              symbol: meta.symbol.toUpperCase(),
              decimals: meta.decimals,
            });
          }
        }
      }
    }

    // Merge unknown tokens that now have metadata
    const unknownNonZero = nonZero.filter((t) =>
      unknownAddresses.includes(t.contractAddress),
    );
    const unknownEntries: TokenEntry[] = unknownNonZero.flatMap((t) => {
      const meta = metaMap.get(t.contractAddress.toLowerCase());
      return meta
        ? [
            {
              contractAddress: t.contractAddress,
              tokenBalance: t.tokenBalance!,
              symbol: meta.symbol,
              decimals: meta.decimals,
            },
          ]
        : [];
    });

    // ── Price and build holdings ─────────────────────────────────────────────
    for (const token of [...knownEntries, ...unknownEntries]) {
      const raw = BigInt(token.tokenBalance);
      const formatted = parseFloat(ethers.formatUnits(raw, token.decimals));
      if (formatted <= 0.000001) continue;

      const price = marketData.get(token.symbol)?.price_usd ?? 0;
      holdings.push({
        symbol: token.symbol,
        address: this.toChecksumSafe(token.contractAddress),
        decimals: token.decimals,
        balanceFormatted: formatted,
        priceUSD: price,
        valueUSD: formatted * price,
      });
    }

    return holdings
      .filter((h) => h.valueUSD > 0.01)
      .sort((a, b) => b.valueUSD - a.valueUSD);
  }

  /**
   * Multicall3 fallback — used when no `ALCHEMY_API_KEY` is set.
   * Fetches all known ERC-20 token balances + native ETH balance for a wallet
   * using a single Multicall3 `aggregate3` call — one RPC round-trip instead of N+1.
   *
   * Multicall3 is deployed at `0xcA11bde05977b3631167028862bE2a173976CA11` on
   * Ethereum mainnet and 250+ other chains. All results come from the same block,
   * giving a consistent atomic snapshot of the wallet.
   *
   * Limitation: only checks tokens in the hardcoded SYMBOL_TO_TOKEN registry.
   */
  private async fetchWalletHoldingsMulticall(
    walletAddress: string,
    marketData: Map<string, CoinGeckoMarketData>,
  ): Promise<WalletHolding[]> {
    const provider = this.getEthProvider();

    // All tokens in the known registry (ETH native handled separately via Multicall3)
    const tokenEntries = Object.entries(SYMBOL_TO_TOKEN).filter(
      ([sym]) => sym !== "ETH", // ETH is native — queried via getEthBalance on Multicall3
    );

    // Interface used only for encoding / decoding balanceOf calldata
    const erc20Iface = new ethers.Interface(ERC20_BALANCE_IFACE_ABI);
    const mc3Iface = new ethers.Interface(MULTICALL3_ABI);

    // ── Build all calls ──────────────────────────────────────────────────────
    // Call 0: getEthBalance(walletAddress) on the Multicall3 contract itself
    const ethBalanceCalldata = mc3Iface.encodeFunctionData("getEthBalance", [
      walletAddress,
    ]);

    // Calls 1…N: balanceOf(walletAddress) for each known ERC-20
    const erc20Calls = tokenEntries.map(([, def]) => ({
      target: def.address,
      allowFailure: true,
      callData: erc20Iface.encodeFunctionData("balanceOf", [walletAddress]),
    }));

    const allCalls = [
      {
        target: MULTICALL3_ADDRESS,
        allowFailure: true,
        callData: ethBalanceCalldata,
      },
      ...erc20Calls,
    ];

    // ── Single RPC call ──────────────────────────────────────────────────────
    const multicall = new ethers.Contract(
      MULTICALL3_ADDRESS,
      MULTICALL3_ABI,
      provider,
    );
    const results = (await multicall.getFunction("aggregate3")(
      allCalls,
    )) as Array<{
      success: boolean;
      returnData: string;
    }>;

    const holdings: WalletHolding[] = [];

    // ── Decode ETH balance (result[0]) ───────────────────────────────────────
    const ethResult = results[0];
    if (ethResult?.success && ethResult.returnData !== "0x") {
      const [ethRaw] = mc3Iface.decodeFunctionResult(
        "getEthBalance",
        ethResult.returnData,
      ) as unknown as [bigint];
      const ethFormatted = parseFloat(ethers.formatEther(ethRaw));
      const ethPrice =
        marketData.get("WETH")?.price_usd ??
        marketData.get("ETH")?.price_usd ??
        0;
      if (ethFormatted > 0.0001) {
        holdings.push({
          symbol: "ETH",
          address: "ETH",
          decimals: 18,
          balanceFormatted: ethFormatted,
          priceUSD: ethPrice,
          valueUSD: ethFormatted * ethPrice,
        });
      }
    }

    // ── Decode ERC-20 balances (results[1…N]) ────────────────────────────────
    for (let i = 0; i < tokenEntries.length; i++) {
      const result = results[i + 1];
      if (!result?.success || result.returnData === "0x") continue;

      const [sym, def] = tokenEntries[i]!;
      try {
        const [raw] = erc20Iface.decodeFunctionResult(
          "balanceOf",
          result.returnData,
        ) as unknown as [bigint];
        const formatted = parseFloat(ethers.formatUnits(raw, def.decimals));
        if (formatted <= 0.000001) continue;

        const price = marketData.get(sym)?.price_usd ?? 0;
        holdings.push({
          symbol: sym,
          address: this.toChecksumSafe(def.address),
          decimals: def.decimals,
          balanceFormatted: formatted,
          priceUSD: price,
          valueUSD: formatted * price,
        });
      } catch {
        // Failed decode for one token — skip it, others are unaffected
      }
    }

    // Sort by USD value descending; filter dust < $0.01
    return holdings
      .filter((h) => h.valueUSD > 0.01)
      .sort((a, b) => b.valueUSD - a.valueUSD);
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

  private detectGoalFocus(
    goal: string,
  ): "l2" | "ai" | "defi" | "staking" | "safe_haven" | null {
    const g = goal.toLowerCase();
    if (/\b(layer[\s-]?2|l2|arbitrum|optimism|polygon|rollup|zk)\b/.test(g)) {
      return "l2";
    }
    if (
      /\b(ai|artificial intelligence|agentic|machine learning|llm)\b/.test(g)
    ) {
      return "ai";
    }
    if (/\b(defi|dex|amm|lending|yield)\b/.test(g)) {
      return "defi";
    }
    if (/\b(staking|stake|validator|restaking|lido|rocket pool)\b/.test(g)) {
      return "staking";
    }
    if (/\b(safe haven|defensive|capital preservation|btc|bitcoin)\b/.test(g)) {
      return "safe_haven";
    }
    return null;
  }

  private applyGoalAwareOrdering(
    candidates: TokenCandidate[],
    pools: PoolSnapshot[],
    marketData: Map<string, CoinGeckoMarketData>,
    minLiquidityUSD: number,
    goalFocus: "l2" | "ai" | "defi" | "staking" | "safe_haven" | null,
    focusSymbolsDynamic: string[],
  ): TokenCandidate[] {
    if (!goalFocus) return candidates;

    const focusSymbols = new Set(
      focusSymbolsDynamic.map((s) => s.toUpperCase()),
    );
    if (focusSymbols.size === 0) {
      logger.info(
        `[Researcher] Goal focus=${goalFocus} requested but internet symbol discovery returned none; keeping default ordering`,
      );
      return candidates;
    }

    // Ensure focused symbols missing from LLM output are pulled from live pools.
    const seeded = this.topUpFocusCandidates(
      candidates,
      pools,
      marketData,
      minLiquidityUSD,
      focusSymbols,
    );

    const focused = seeded.filter((c) =>
      focusSymbols.has(c.symbol.toUpperCase()),
    );
    const nonFocused = seeded.filter(
      (c) => !focusSymbols.has(c.symbol.toUpperCase()),
    );

    const sortBySafetyUtility = (a: TokenCandidate, b: TokenCandidate) => {
      // Higher liquidity and volume are safer/useful; lower absolute vol is safer.
      const liq = b.liquidityUSD - a.liquidityUSD;
      if (liq !== 0) return liq;
      const vol = (b.volume24hUSD ?? 0) - (a.volume24hUSD ?? 0);
      if (vol !== 0) return vol;
      const av = Math.abs(a.priceChange24hPct ?? 0);
      const bv = Math.abs(b.priceChange24hPct ?? 0);
      return av - bv;
    };

    focused.sort(sortBySafetyUtility);
    nonFocused.sort(sortBySafetyUtility);

    if (focused.length > 0) {
      logger.info(
        `[Researcher] Goal focus=${goalFocus}: prioritizing ${focused.length} focus candidate(s) ahead of ${nonFocused.length} non-focus candidate(s)`,
      );
      // Goal-specific asks (e.g. "find L2 tokens") should return focused tokens first.
      return [...focused, ...nonFocused];
    }

    logger.info(
      `[Researcher] Goal focus=${goalFocus} requested but no focus tokens passed validation; returning best available candidates`,
    );
    return seeded.sort(sortBySafetyUtility);
  }

  private topUpFocusCandidates(
    existing: TokenCandidate[],
    pools: PoolSnapshot[],
    marketData: Map<string, CoinGeckoMarketData>,
    minLiquidityUSD: number,
    focusSymbols: Set<string>,
  ): TokenCandidate[] {
    const seen = new Set(existing.map((c) => c.symbol.toUpperCase()));
    const filled = [...existing];

    const focusPools = pools
      .filter((p) => focusSymbols.has(p.tokenSymbol.toUpperCase()))
      .filter((p) => p.liquidityUSD >= minLiquidityUSD)
      .filter(
        (p) =>
          !isStablecoin({ symbol: p.tokenSymbol, address: p.tokenAddress }),
      )
      .sort((a, b) => b.liquidityUSD - a.liquidityUSD);

    for (const pool of focusPools) {
      const sym = pool.tokenSymbol.toUpperCase();
      if (seen.has(sym)) continue;
      seen.add(sym);
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
