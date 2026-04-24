import { ZGCompute, type InferOptions } from "@swarm/compute";
import { BlackboardMemory } from "@swarm/memory";
import { logger, getConfig } from "@swarm/shared";
import type { ResearchReport, TokenCandidate, TradePlan } from "@swarm/shared";
import { ethers } from "ethers";

// ─── Minimal Uniswap V3 Pool ABI ──────────────────────────────────────────────

const POOL_ABI = [
  "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)",
  "function liquidity() external view returns (uint128)",
];

// ─── Known Uniswap V3 pools (Ethereum mainnet, by TVL) ────────────────────────

interface PoolDef {
  address: string;
  token0: { symbol: string; name: string; address: string; decimals: number };
  token1: { symbol: string; name: string; address: string; decimals: number };
  feeTier: number;
  /** When true, report price as 1/raw (e.g. WETH price in USDC for a USDC/WETH pool) */
  invertPrice: boolean;
  priceLabel: string; // human-readable e.g. "WETH in USDC"
}

const KNOWN_POOLS: PoolDef[] = [
  {
    address: "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640",
    token0: { symbol: "USDC", name: "USD Coin",       address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6  },
    token1: { symbol: "WETH", name: "Wrapped Ether",  address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", decimals: 18 },
    feeTier: 500, invertPrice: true,  priceLabel: "WETH in USDC",
  },
  {
    address: "0x8ad599c3A0ff1De082011EFDDc58f1908eb6e6D8",
    token0: { symbol: "USDC", name: "USD Coin",       address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6  },
    token1: { symbol: "WETH", name: "Wrapped Ether",  address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", decimals: 18 },
    feeTier: 3000, invertPrice: true, priceLabel: "WETH in USDC",
  },
  {
    address: "0x4e68Ccd3E89f51C3074ca5072bbAC773960dFa36",
    token0: { symbol: "WETH",  name: "Wrapped Ether",  address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", decimals: 18 },
    token1: { symbol: "USDT",  name: "Tether USD",     address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6  },
    feeTier: 500, invertPrice: false, priceLabel: "USDT per WETH",
  },
  {
    address: "0x3416cF6C708Da44DB2624D63ea0AAef7113527C6",
    token0: { symbol: "USDC",  name: "USD Coin",       address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6  },
    token1: { symbol: "USDT",  name: "Tether USD",     address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6  },
    feeTier: 100, invertPrice: false, priceLabel: "USDT per USDC",
  },
  {
    address: "0xCBCdF9626bC03E24f779434178A73a0B4bad62eD",
    token0: { symbol: "WBTC",  name: "Wrapped Bitcoin", address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", decimals: 8  },
    token1: { symbol: "WETH",  name: "Wrapped Ether",   address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", decimals: 18 },
    feeTier: 3000, invertPrice: false, priceLabel: "WETH per WBTC",
  },
  {
    address: "0x4585FE77225b41b697C938B018E2Ac67Ac5a20c0",
    token0: { symbol: "WBTC",  name: "Wrapped Bitcoin", address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", decimals: 8  },
    token1: { symbol: "WETH",  name: "Wrapped Ether",   address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", decimals: 18 },
    feeTier: 500, invertPrice: false, priceLabel: "WETH per WBTC",
  },
  {
    address: "0x5777d92f208679DB4b9778590Fa3CAB3aC9e2168",
    token0: { symbol: "DAI",   name: "Dai Stablecoin",  address: "0x6B175474E89094C44Da98b954EedeAC495271d0F", decimals: 18 },
    token1: { symbol: "USDC",  name: "USD Coin",        address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6  },
    feeTier: 100, invertPrice: false, priceLabel: "USDC per DAI",
  },
  {
    address: "0xC2e9F25Be6257c210d7Adf0D4Cd6E3E881ba25f8",
    token0: { symbol: "DAI",   name: "Dai Stablecoin",  address: "0x6B175474E89094C44Da98b954EedeAC495271d0F", decimals: 18 },
    token1: { symbol: "WETH",  name: "Wrapped Ether",   address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", decimals: 18 },
    feeTier: 3000, invertPrice: true, priceLabel: "WETH in DAI",
  },
  {
    address: "0xa6Cc3C2531FdaA6Ae1A3CA84c2855806728693e8",
    token0: { symbol: "LINK",  name: "Chainlink",       address: "0x514910771AF9Ca656af840dff83E8264EcF986CA", decimals: 18 },
    token1: { symbol: "WETH",  name: "Wrapped Ether",   address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", decimals: 18 },
    feeTier: 3000, invertPrice: false, priceLabel: "WETH per LINK",
  },
  {
    address: "0x1d42064Fc4Beb5F8aAF85F4617AE8b3b5B8Bd801",
    token0: { symbol: "UNI",   name: "Uniswap",         address: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984", decimals: 18 },
    token1: { symbol: "WETH",  name: "Wrapped Ether",   address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", decimals: 18 },
    feeTier: 3000, invertPrice: false, priceLabel: "WETH per UNI",
  },
];

// ─── On-chain pool snapshot ────────────────────────────────────────────────────

interface PoolSnapshot {
  address: string;
  token0Symbol: string;
  token1Symbol: string;
  feePct: number;
  priceLabel: string;
  currentPrice: number;
  /** virtual token1 amount at current tick — proxy for in-range liquidity */
  virtualToken1: number;
  liquidityRaw: string;
  tick: number;
}

// ─── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are the Research agent in a Uniswap trading swarm.
You receive live on-chain Uniswap V3 pool data and a trading plan, then you
produce a structured research report identifying the best candidate token pairs.

Pool data fields explained:
- currentPrice: human-readable price (see priceLabel for the pair direction)
- virtualToken1: virtual in-range liquidity in token1 units — larger = more liquid
- feePct: pool fee as a percentage (e.g., 0.05 = 0.05%)
- liquidityRaw: raw uint128 liquidity from the contract

Rules:
- Only recommend pairs with sufficient liquidity (respect minLiquidityUSD from plan)
- Estimate liquidityUSD from virtualToken1 and known ETH/USD prices where possible
- Score candidates based on liquidity depth and fee competitiveness
- For priceUSD of WETH, use currentPrice from the USDC/WETH pools
- Output ONLY valid JSON matching the ResearchReport schema
- Never fabricate — use only the on-chain data provided

Schema:
{
  "timestamp": number,
  "marketSummary": "<2–3 sentence market overview>",
  "candidates": [
    {
      "address": "<token address (non-WETH/stablecoin token in the pair)>",
      "symbol": "<token symbol>",
      "name": "<token name>",
      "pairAddress": "<pool address>",
      "baseToken": "<WETH|USDC|USDT>",
      "priceUSD": number,
      "liquidityUSD": number,
      "volume24hUSD": number,
      "priceChange24hPct": number,
      "poolFeeTier": number,
      "txCount": number
    }
  ],
  "dataSource": "uniswap-v3-onchain"
}`;

// ─── ResearchAgent ─────────────────────────────────────────────────────────────

export class ResearchAgent {
  static readonly MEMORY_KEY = "researcher/report";
  readonly id = "researcher";
  readonly role = "Researcher";

  private readonly compute: ZGCompute;
  private readonly memory: BlackboardMemory;

  constructor(compute: ZGCompute, memory: BlackboardMemory) {
    this.compute = compute;
    this.memory = memory;
  }

  async run(plan: TradePlan, opts: InferOptions = {}): Promise<ResearchReport> {
    logger.info(`[Researcher] Fetching Uniswap V3 pool data (on-chain)…`);

    const pools = await this.fetchOnChainPools();
    logger.info(`[Researcher] Fetched ${pools.length} pools from chain`);

    const context = this.memory.contextFor(ResearchAgent.MEMORY_KEY);

    const userPrompt = [
      `Trading plan:\n${JSON.stringify(plan, null, 2)}`,
      `Live Uniswap V3 on-chain pool snapshots:\n${JSON.stringify(pools, null, 2)}`,
      context,
    ]
      .filter(Boolean)
      .join("\n\n");

    const report = await this.compute.inferJSON<ResearchReport>(
      SYSTEM_PROMPT,
      userPrompt,
      { maxTokens: 2048, ...opts }
    );

    report.timestamp = Date.now();
    report.dataSource = "uniswap-v3-onchain";

    // Enforce liquidity constraint hard — LLM cannot bypass
    report.candidates = report.candidates.filter(
      (c: TokenCandidate) => c.liquidityUSD >= plan.constraints.minLiquidityUSD
    );

    await this.memory.write(
      ResearchAgent.MEMORY_KEY,
      this.id,
      this.role,
      report
    );
    logger.info(
      `[Researcher] Done — ${report.candidates.length} candidates found`
    );
    return report;
  }

  // ── On-chain query ──────────────────────────────────────────────────────────

  private async fetchOnChainPools(): Promise<PoolSnapshot[]> {
    const { ETH_RPC_URL } = getConfig();
    // staticNetwork skips auto-detection, preventing "failed to detect network" errors
    const provider = new ethers.JsonRpcProvider(
      ETH_RPC_URL,
      1, // ethereum mainnet
      { staticNetwork: true }
    );

    const snapshots: PoolSnapshot[] = [];

    await Promise.all(
      KNOWN_POOLS.map(async (def) => {
        try {
          const contract = new ethers.Contract(def.address, POOL_ABI, provider);

          const [slot0Result, liquidityResult] = await Promise.all([
            contract.getFunction("slot0")() as Promise<[bigint, bigint, ...unknown[]]>,
            contract.getFunction("liquidity")() as Promise<bigint>,
          ]);

          const sqrtPriceX96 = slot0Result[0];
          const tick = Number(slot0Result[1]);
          const liquidityRaw = liquidityResult;

          // price = (sqrtPriceX96 / 2^96)^2  * 10^(d0 - d1)
          const Q96 = 2n ** 96n;
          const sqrtPNum = Number(sqrtPriceX96) / Number(Q96);
          const decimalAdj = Math.pow(10, def.token0.decimals - def.token1.decimals);
          const priceRaw = sqrtPNum * sqrtPNum * decimalAdj;
          const currentPrice = def.invertPrice ? 1 / priceRaw : priceRaw;

          // virtual token1 = L * sqrtPrice / Q96 (in smallest token1 units)
          // divide by 10^d1 for human-readable amount
          const virtualToken1Raw =
            (Number(liquidityRaw) * Number(sqrtPriceX96)) / Number(Q96);
          const virtualToken1 = virtualToken1Raw / Math.pow(10, def.token1.decimals);

          snapshots.push({
            address: def.address,
            token0Symbol: def.token0.symbol,
            token1Symbol: def.token1.symbol,
            feePct: def.feeTier / 10000,
            priceLabel: def.priceLabel,
            currentPrice: Number(currentPrice.toFixed(6)),
            virtualToken1: Number(virtualToken1.toFixed(4)),
            liquidityRaw: liquidityRaw.toString(),
            tick,
          });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn(`[Researcher] Skipping pool ${def.address}: ${msg}`);
        }
      })
    );

    // Sort by virtualToken1 descending (most liquid first)
    return snapshots.sort((a, b) => b.virtualToken1 - a.virtualToken1);
  }
}
