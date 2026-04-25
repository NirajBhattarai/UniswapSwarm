import { ethers } from "ethers";
import { BlackboardMemory } from "@swarm/memory";
import { logger, getConfig, UNISWAP } from "@swarm/shared";
import type { TradeStrategy, Critique, ExecutionResult } from "@swarm/shared";

// ─── Safety guard ─────────────────────────────────────────────────────────────
// SIMULATION_ONLY=true → pure mock result, no RPC calls, always succeeds → saved to 0G Storage.
// Set to false + DRY_RUN=false in .env only when wallet is funded and ready for live trades.
const SIMULATION_ONLY = true;

// ─── Uniswap V3 SwapRouter02 ABI (minimal) ────────────────────────────────────

const SWAP_ROUTER_ABI = [
  `function exactInputSingle(tuple(
    address tokenIn,
    address tokenOut,
    uint24 fee,
    address recipient,
    uint256 amountIn,
    uint256 amountOutMinimum,
    uint160 sqrtPriceLimitX96
  ) params) external payable returns (uint256 amountOut)`,
] as const;

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function balanceOf(address account) external view returns (uint256)",
  "function decimals() external view returns (uint8)",
] as const;

// ─── ExecutorAgent ─────────────────────────────────────────────────────────────

export class ExecutorAgent {
  static readonly MEMORY_KEY = "executor/result";
  readonly id = "executor";
  readonly role = "Executor";

  private readonly memory: BlackboardMemory;
  private wallet: ethers.Wallet | null = null;

  constructor(memory: BlackboardMemory) {
    this.memory = memory;
  }

  private getWallet(): ethers.Wallet {
    if (!this.wallet) {
      const cfg = getConfig();
      const provider = new ethers.JsonRpcProvider(cfg.ETH_RPC_URL);
      this.wallet = new ethers.Wallet(cfg.ZG_PRIVATE_KEY, provider);
    }
    return this.wallet;
  }

  async run(): Promise<ExecutionResult> {
    // ── Read strategy + critique from 0G-backed shared memory ────────────────────
    const strategy = this.memory.readValue<TradeStrategy>("strategy/proposal");
    const critique = this.memory.readValue<Critique>("critic/critique");

    if (!strategy || !critique) {
      throw new Error(
        "[Executor] strategy/proposal and critic/critique must be in shared memory first",
      );
    }

    if (!critique.approved) {
      logger.warn(
        `[Executor] Critic rejected trade — skipping execution. Issues: ${critique.issues.join("; ")}`,
      );
      const skipped: ExecutionResult = {
        dryRun: false,
        txHash: null,
        success: false,
        amountIn: strategy.amountInWei,
        amountOut: null,
        gasUsed: null,
        priceImpactPct: null,
        executedAt: Date.now(),
        error: `Critic rejected: ${critique.summary}`,
      };
      await this.memory.write(
        ExecutorAgent.MEMORY_KEY,
        this.id,
        this.role,
        skipped,
      );
      return skipped;
    }

    const cfg = getConfig();

    if (SIMULATION_ONLY || cfg.DRY_RUN) {
      if (SIMULATION_ONLY && !cfg.DRY_RUN) {
        logger.warn(
          "[Executor] SIMULATION_ONLY guard is active — ignoring DRY_RUN=false. No real trade will be submitted.",
        );
      }
      return await this.simulateTrade(strategy);
    }

    return await this.executeTrade(strategy);
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

  // ── Live execution (DRY_RUN=false) ─────────────────────────────────────────

  private async executeTrade(
    strategy: TradeStrategy,
  ): Promise<ExecutionResult> {
    logger.info(
      `[Executor] LIVE — executing ${strategy.tokenInSymbol}→${strategy.tokenOutSymbol}`,
    );

    let result: ExecutionResult;

    try {
      const wallet = this.getWallet();
      const tokenIn = new ethers.Contract(strategy.tokenIn, ERC20_ABI, wallet);
      const router = new ethers.Contract(
        UNISWAP.SWAP_ROUTER_02,
        SWAP_ROUTER_ABI,
        wallet,
      );

      // Approve router if needed
      const allowanceFn = tokenIn.getFunction("allowance");
      const allowance = (await allowanceFn(
        wallet.address,
        UNISWAP.SWAP_ROUTER_02,
      )) as bigint;
      const needed = BigInt(strategy.amountInWei);
      if (allowance < needed) {
        logger.info("[Executor] Approving router…");
        const approveFn = tokenIn.getFunction("approve");
        const approveTx = (await approveFn(
          UNISWAP.SWAP_ROUTER_02,
          ethers.MaxUint256,
        )) as ethers.TransactionResponse;
        await approveTx.wait();
      }

      const params = {
        tokenIn: strategy.tokenIn,
        tokenOut: strategy.tokenOut,
        fee: strategy.poolFee,
        recipient: wallet.address,
        amountIn: strategy.amountInWei,
        amountOutMinimum: strategy.minAmountOutWei,
        sqrtPriceLimitX96: 0n,
      };

      const swapFn = router.getFunction("exactInputSingle");
      const tx = (await swapFn(params, {
        value: strategy.tokenInSymbol === "WETH" ? strategy.amountInWei : 0n,
      })) as ethers.TransactionResponse;

      logger.info(`[Executor] Tx submitted: ${tx.hash}`);
      const receipt = await tx.wait();

      const reverted = receipt?.status !== 1;
      result = {
        dryRun: false,
        txHash: tx.hash,
        success: !reverted,
        amountIn: strategy.amountInWei,
        amountOut: null, // would need to decode Transfer event
        gasUsed: receipt?.gasUsed.toString() ?? null,
        priceImpactPct: null,
        executedAt: Date.now(),
        ...(reverted ? { error: "Transaction reverted" } : {}),
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error(`[Executor] Live execution failed: ${error}`);
      result = {
        dryRun: false,
        txHash: null,
        success: false,
        amountIn: strategy.amountInWei,
        amountOut: null,
        gasUsed: null,
        priceImpactPct: null,
        executedAt: Date.now(),
        error,
      };
    }

    await this.memory.write(
      ExecutorAgent.MEMORY_KEY,
      this.id,
      this.role,
      result,
    );
    return result;
  }
}
