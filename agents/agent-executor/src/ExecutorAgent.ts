import { BlackboardMemory } from "@swarm/memory";
import {
  logger,
  getConfig,
  isStablecoin,
  TOKENS,
  ZERO_ADDRESS,
} from "@swarm/shared";
import type {
  TradeStrategy,
  Critique,
  ExecutionResult,
  WalletHolding,
} from "@swarm/shared";

// ─── Safety guard ─────────────────────────────────────────────────────────────
// SIMULATION_ONLY=true → pure mock result, no prompts, always succeeds.
// Swaps are NEVER executed server-side; the live path is always HITL (user EOA).
const SIMULATION_ONLY =
  process.env.SIMULATION_ONLY === "true" || process.env.SIMULATION_ONLY === "1";

const ETH_ADDRESS_SENTINEL = ZERO_ADDRESS;

// ─── ExecutorAgent ─────────────────────────────────────────────────────────────

export class ExecutorAgent {
  static readonly MEMORY_KEY = "executor/result";
  readonly id = "executor";
  readonly role = "Executor";

  private readonly memory: BlackboardMemory;

  constructor(memory: BlackboardMemory) {
    this.memory = memory;
  }

  async run(): Promise<ExecutionResult> {
    // ── Read strategy + critique from 0G-backed shared memory ────────────────────
    let strategy = this.memory.readValue<TradeStrategy>("strategy/proposal");
    const critique = this.memory.readValue<Critique>("critic/critique");

    if (!strategy || !critique) {
      throw new Error(
        "[Executor] strategy/proposal and critic/critique must be in shared memory first",
      );
    }

    if (!critique.approved) {
      logger.warn(
        `[Executor] Critic rejected trade, but executor was explicitly invoked (likely user override). Issues: ${critique.issues.join("; ")}`,
      );
    }

    // ── Wallet-aware tokenIn selection (stable → ETH → any) ──────────────────
    // Reads holdings written by the Researcher so the executor always spends
    // the best available source token rather than blindly trusting the strategy.
    const walletHoldings =
      this.memory.readValue<WalletHolding[]>("researcher/wallet_holdings") ??
      [];

    if (walletHoldings.length > 0) {
      const cfg0 = getConfig();
      const selected = this.selectTokenIn(
        walletHoldings,
        strategy.tokenOut,
        cfg0.MAX_POSITION_USDC,
      );
      if (selected) {
        const changed =
          selected.tokenIn.toLowerCase() !== strategy.tokenIn.toLowerCase() ||
          selected.amountInWei !== strategy.amountInWei;
        if (changed) {
          logger.info(
            `[Executor] Wallet tokenIn override: ${strategy.tokenInSymbol} → ${selected.tokenInSymbol} ` +
              `| amountInWei ${strategy.amountInWei} → ${selected.amountInWei}`,
          );
        } else {
          logger.info(
            `[Executor] Wallet tokenIn confirmed: ${selected.tokenInSymbol} (no change needed)`,
          );
        }
        strategy = {
          ...strategy,
          tokenIn: selected.tokenIn,
          tokenInSymbol: selected.tokenInSymbol,
          amountInWei: selected.amountInWei,
        };
      } else {
        logger.warn(
          "[Executor] No eligible wallet holding found for tokenIn — using strategy default",
        );
      }
    }

    if (SIMULATION_ONLY) {
      return await this.simulateTrade(strategy);
    }

    // Swaps are always handled by the user's connected EOA wallet via the
    // HITL `request_trade_approval` flow in the frontend. The executor only
    // signals readiness and writes the pending state to 0G KV store.
    return await this.pendingHitlResult(strategy);
  }

  // ── Mock simulation — no RPC calls, always succeeds, saves to 0G Storage ──────

  private async simulateTrade(
    strategy: TradeStrategy,
  ): Promise<ExecutionResult> {
    logger.info(
      `[Executor] MOCK — simulating ${strategy.tokenInSymbol}→${strategy.tokenOutSymbol} ` +
        `| amountIn=${strategy.amountInWei} minOut=${strategy.minAmountOutWei}`,
    );

    // Pure mock: derive a realistic amountOut = minAmountOutWei * 1.005 (0.5% above floor)
    const minOut = BigInt(strategy.minAmountOutWei);
    const mockAmountOut = (minOut * 1005n) / 1000n;

    const result: ExecutionResult = {
      dryRun: true,
      txHash: null,
      success: true,
      amountIn: strategy.amountInWei,
      amountOut: mockAmountOut.toString(),
      gasUsed: "150000",
      priceImpactPct: strategy.slippagePct,
      executedAt: Date.now(),
    };

    // Write to BlackboardMemory → persisted to 0G Storage KV
    await this.memory.write(
      ExecutorAgent.MEMORY_KEY,
      this.id,
      this.role,
      result,
    );

    logger.info(
      `[Executor] MOCK result saved to 0G Storage — success=true amountOut=${mockAmountOut}`,
    );
    return result;
  }

  // ── HITL sentinel ───────────────────────────────────────────────────────────────────
  // Swaps are NEVER executed server-side. This result signals the orchestrator
  // LLM that the trade is ready and waiting for the user's EOA wallet signature
  // via the `request_trade_approval` HITL card in the frontend.

  private async pendingHitlResult(
    strategy: TradeStrategy,
  ): Promise<ExecutionResult> {
    logger.info(
      `[Executor] PENDING_HITL — ${strategy.tokenInSymbol}→${strategy.tokenOutSymbol}` +
        ` | amountIn=${strategy.amountInWei} — awaiting EOA wallet signature via UI`,
    );
    const result: ExecutionResult = {
      dryRun: false,
      txHash: null,
      success: false,
      amountIn: strategy.amountInWei,
      amountOut: null,
      gasUsed: null,
      priceImpactPct: strategy.slippagePct,
      executedAt: Date.now(),
      error:
        "PENDING_HITL: swap awaiting approval and signature from connected EOA wallet via the UI.",
    };
    await this.memory.write(
      ExecutorAgent.MEMORY_KEY,
      this.id,
      this.role,
      result,
    );
    return result;
  }

  // ── Wallet-aware tokenIn selection ─────────────────────────────────────────

  /**
   * Priority order:
   *  1. Stablecoin with the highest USD value (USDC, USDT, DAI, …)
   *  2. ETH / WETH
   *  3. Any other token with the highest USD value
   *
   * Returns null only when the wallet is empty or every holding is the
   * destination token itself.
   */
  private selectTokenIn(
    holdings: WalletHolding[],
    tokenOutAddress: string,
    maxPositionUSD: number,
  ): { tokenIn: string; tokenInSymbol: string; amountInWei: string } | null {
    const tokenOutLower = tokenOutAddress.toLowerCase();
    const WETH_LOWER = TOKENS.WETH.toLowerCase();

    const eligible = holdings.filter((h) => {
      if (h.balanceFormatted <= 0 || h.valueUSD < 0.5) return false;
      const addr = h.address.toLowerCase();
      // Skip the tokenOut itself
      if (addr === tokenOutLower) return false;
      // Native ETH and WETH are interchangeable — skip if tokenOut is the other
      const isNativeEth =
        addr === "eth" ||
        addr === ETH_ADDRESS_SENTINEL ||
        h.symbol.toUpperCase() === "ETH";
      if (isNativeEth && tokenOutLower === WETH_LOWER) return false;
      if (addr === WETH_LOWER && tokenOutLower === "eth") return false;
      return true;
    });

    if (eligible.length === 0) return null;

    // Priority 1: stablecoins
    const stables = eligible.filter((h) =>
      isStablecoin({ symbol: h.symbol, address: h.address }),
    );
    if (stables.length > 0) {
      const best = stables.reduce((a, b) => (a.valueUSD >= b.valueUSD ? a : b));
      logger.info(
        `[Executor] tokenIn selection — STABLE: ${best.symbol} ($${best.valueUSD.toFixed(2)})`,
      );
      return this.holdingToTokenIn(best, maxPositionUSD);
    }

    // Priority 2: ETH / WETH
    const ethHolding = eligible.find(
      (h) =>
        h.symbol.toUpperCase() === "ETH" ||
        h.symbol.toUpperCase() === "WETH" ||
        h.address.toLowerCase() === WETH_LOWER,
    );
    if (ethHolding) {
      logger.info(
        `[Executor] tokenIn selection — ETH/WETH: ${ethHolding.symbol} ($${ethHolding.valueUSD.toFixed(2)})`,
      );
      return this.holdingToTokenIn(ethHolding, maxPositionUSD);
    }

    // Priority 3: highest-value token
    const best = eligible.reduce((a, b) => (a.valueUSD >= b.valueUSD ? a : b));
    logger.info(
      `[Executor] tokenIn selection — FALLBACK: ${best.symbol} ($${best.valueUSD.toFixed(2)})`,
    );
    return this.holdingToTokenIn(best, maxPositionUSD);
  }

  private holdingToTokenIn(
    holding: WalletHolding,
    maxPositionUSD: number,
  ): { tokenIn: string; tokenInSymbol: string; amountInWei: string } {
    const spendUSD = Math.min(holding.valueUSD, maxPositionUSD);
    const spendUnits = spendUSD / holding.priceUSD;
    const amountInWei = BigInt(
      Math.round(spendUnits * 10 ** holding.decimals),
    ).toString();

    // Native ETH must be wrapped for Uniswap — use WETH address
    const isNativeEth =
      holding.address.toLowerCase() === "eth" ||
      holding.address === ETH_ADDRESS_SENTINEL ||
      holding.symbol.toUpperCase() === "ETH";

    const tokenIn = isNativeEth ? TOKENS.WETH : holding.address;
    const tokenInSymbol = isNativeEth ? "WETH" : holding.symbol;

    return { tokenIn, tokenInSymbol, amountInWei };
  }
}
