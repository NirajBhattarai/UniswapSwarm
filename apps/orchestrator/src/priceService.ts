import { ethers } from "ethers";
import {
  getConfig,
  logger,
  isStablecoin,
  ETHEREUM_MAINNET_RESEARCHER_TOKEN_REGISTRY,
  USDC_DEF,
  UNISWAP_TRADE_API_BASE_URL,
} from "@swarm/shared";
import { fetchCoinGeckoMarketData } from "@swarm/agent-researcher";
import type { CoinGeckoMarketData } from "@swarm/agent-researcher";

export interface TokenPriceResult {
  symbol: string;
  address: string;
  price_usd: number | null;
  source: "uniswap";
  liquidity_used: string;
  volume_24h_usd?: number | null;
  price_change_24h_pct?: number | null;
  market_cap_usd?: number | null;
}

export interface PriceQuoteResponse {
  data: TokenPriceResult[];
}

// ─── Token registry ───────────────────────────────────────────────────────────

interface TokenDef {
  address: string;
  decimals: number;
  isStablecoin?: boolean;
}

const SYMBOL_TO_TOKEN = ETHEREUM_MAINNET_RESEARCHER_TOKEN_REGISTRY as Record<
  string,
  TokenDef
>;

const ADDRESS_TO_SYMBOL: Record<string, string> = Object.fromEntries(
  Object.entries(SYMBOL_TO_TOKEN).map(([sym, def]) => [
    def.address.toLowerCase(),
    sym,
  ]),
);

const ERC20_META_ABI = [
  "function symbol() external view returns (string)",
  "function decimals() external view returns (uint8)",
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizeSymbol(value: string): string {
  return value.trim().toUpperCase();
}

function normalizeAddress(value: string): string {
  return value.trim().toLowerCase();
}

function dedupeTokenInputs(tokens: string[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const token of tokens) {
    const key = token.trim();
    if (key && !seen.has(key)) {
      seen.add(key);
      ordered.push(key);
    }
  }
  return ordered;
}

function isPriceValid(price: number, token: TokenDef): boolean {
  if (!isFinite(price) || price <= 0) return false;
  if (token.isStablecoin) return Math.abs(price - 1.0) <= 0.02;
  return price >= 1e-6 && price <= 10_000_000;
}

async function requestUniswapQuote(
  apiKey: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${UNISWAP_TRADE_API_BASE_URL}/quote`, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
}

// ─── PriceService ─────────────────────────────────────────────────────────────

const UNISWAP_SOURCE = "uniswap" as const;
const LIQUIDITY_TOKEN_USDC = "TOKEN/USDC";
const LIQUIDITY_NONE = "NONE";
const CACHE_TTL_MS = 15_000;

export class PriceService {
  private readonly priceCache = new Map<
    string,
    { result: TokenPriceResult; expiresAt: number }
  >();

  private _ethProvider: ethers.JsonRpcProvider | null = null;

  private getEthProvider(): ethers.JsonRpcProvider {
    if (!this._ethProvider) {
      const { ETH_RPC_URL } = getConfig();
      this._ethProvider = new ethers.JsonRpcProvider(ETH_RPC_URL, 1, {
        staticNetwork: true,
      });
    }
    return this._ethProvider;
  }

  private cachePrice(key: string, result: TokenPriceResult): void {
    this.priceCache.set(key, { result, expiresAt: Date.now() + CACHE_TTL_MS });
  }

  private buildUnresolvable(symbol: string, address: string): TokenPriceResult {
    return {
      symbol,
      address,
      price_usd: null,
      source: UNISWAP_SOURCE,
      liquidity_used: LIQUIDITY_NONE,
    };
  }

  async fetchTokenPrices(tokens: string[]): Promise<PriceQuoteResponse> {
    const provider = this.getEthProvider();
    const ordered = dedupeTokenInputs(tokens);

    const [results, marketData] = await Promise.all([
      Promise.all(ordered.map((t) => this.resolveTokenPrice(t, provider))),
      fetchCoinGeckoMarketData(ordered),
    ]);

    for (const r of results) {
      const cg = marketData.get(r.symbol) as CoinGeckoMarketData | undefined;
      if (cg) {
        r.volume_24h_usd = cg.volume_24h_usd;
        r.price_change_24h_pct = cg.price_change_24h_pct;
        r.market_cap_usd = cg.market_cap_usd;
        if (r.price_usd === null) r.price_usd = cg.price_usd;
      }
    }

    return { data: results };
  }

  async fetchCoinGeckoMarketData(
    symbols: string[],
  ): Promise<Map<string, CoinGeckoMarketData>> {
    return fetchCoinGeckoMarketData(symbols);
  }

  private async resolveTokenPrice(
    input: string,
    provider: ethers.JsonRpcProvider,
  ): Promise<TokenPriceResult> {
    const upperSymbol = normalizeSymbol(input);
    const isAddress = /^0x[0-9a-fA-F]{40}$/.test(input);

    let tokenDef: TokenDef | undefined;
    let canonicalSymbol: string;

    if (isAddress) {
      const addressKey = normalizeAddress(input);
      const knownSymbol = ADDRESS_TO_SYMBOL[addressKey];
      if (knownSymbol) {
        canonicalSymbol = knownSymbol;
        tokenDef = SYMBOL_TO_TOKEN[knownSymbol];
      } else {
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
          return this.buildUnresolvable(input, input);
        }
      }
    } else {
      canonicalSymbol = upperSymbol;
      tokenDef = SYMBOL_TO_TOKEN[upperSymbol];
      if (!tokenDef) {
        logger.warn(`[PriceService] Unknown token symbol: ${input}`);
        return this.buildUnresolvable(input, "0x");
      }
    }

    if (!tokenDef) return this.buildUnresolvable(input, "0x");

    const cacheKey = tokenDef.address.toLowerCase();
    const cached = this.priceCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      logger.debug(`[PriceService] Cache hit for ${canonicalSymbol}`);
      return cached.result;
    }

    if (isStablecoin({ symbol: canonicalSymbol, address: tokenDef.address })) {
      const result: TokenPriceResult = {
        symbol: canonicalSymbol,
        address: tokenDef.address,
        price_usd: 1.0,
        source: UNISWAP_SOURCE,
        liquidity_used: LIQUIDITY_TOKEN_USDC,
      };
      this.cachePrice(cacheKey, result);
      return result;
    }

    const apiPrice = await this.priceViaTradeApi(tokenDef, canonicalSymbol);
    if (apiPrice !== null) {
      const result: TokenPriceResult = {
        symbol: canonicalSymbol,
        address: tokenDef.address,
        price_usd: apiPrice,
        source: UNISWAP_SOURCE,
        liquidity_used: LIQUIDITY_TOKEN_USDC,
      };
      this.cachePrice(cacheKey, result);
      return result;
    }

    return this.buildUnresolvable(canonicalSymbol, tokenDef.address);
  }

  private async priceViaTradeApi(
    token: TokenDef,
    symbol: string,
  ): Promise<number | null> {
    const { UNISWAP_API_KEY } = getConfig();
    if (!UNISWAP_API_KEY) return null;

    if (token.address.toLowerCase() === USDC_DEF.address.toLowerCase())
      return null;

    const amountIn = (BigInt(10) ** BigInt(token.decimals)).toString();

    try {
      const response = await requestUniswapQuote(UNISWAP_API_KEY, {
        tokenIn: token.address,
        tokenOut: USDC_DEF.address,
        amount: amountIn,
        type: "EXACT_INPUT",
        tokenInChainId: 1,
        tokenOutChainId: 1,
        swapper: "0x0000000000000000000000000000000000000001",
      });

      if (!response.ok) {
        logger.warn(
          `[PriceService] Trade API ${response.status} for ${symbol}: ${await response.text()}`,
        );
        return null;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = (await response.json()) as Record<string, any>;
      const quote = body["quote"] as Record<string, unknown> | undefined;
      if (!quote) return null;

      // CLASSIC routing
      const classicOutput = (
        quote["output"] as Record<string, unknown> | undefined
      )?.["amount"];
      if (typeof classicOutput === "string") {
        const price = Number(classicOutput) / 10 ** USDC_DEF.decimals;
        if (isPriceValid(price, token)) {
          logger.debug(`[PriceService] CLASSIC ${symbol} → $${price}`);
          return price;
        }
      }

      // UniswapX/Dutch routing
      const orderInfo = quote["orderInfo"] as
        | Record<string, unknown>
        | undefined;
      const outputs = orderInfo?.["outputs"];
      if (Array.isArray(outputs) && outputs.length > 0) {
        const firstOut = outputs[0] as Record<string, unknown>;
        const startAmt = firstOut["startAmount"];
        if (typeof startAmt === "string") {
          const price = Number(startAmt) / 10 ** USDC_DEF.decimals;
          if (isPriceValid(price, token)) {
            logger.debug(`[PriceService] UniswapX ${symbol} → $${price}`);
            return price;
          }
        }
      }

      logger.warn(`[PriceService] Unrecognised quote shape for ${symbol}`);
      return null;
    } catch (err) {
      logger.warn(
        `[PriceService] Fetch error for ${symbol}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }
}
