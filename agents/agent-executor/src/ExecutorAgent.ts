import { ethers } from "ethers";
import { BlackboardMemory } from "@swarm/memory";
import { logger, getConfig, UNISWAP } from "@swarm/shared";
import type {
  TradeStrategy,
  Critique,
  ExecutionResult,
} from "@swarm/shared";

// ─── Safety guard ─────────────────────────────────────────────────────────────
// TODO: Set SIMULATION_ONLY = false and DRY_RUN=false in .env to enable real trades.
// TODO: Fund the wallet (ZG_PRIVATE_KEY) with ETH + input token before live execution.
// TODO: Set ETH_RPC_URL to a private RPC (Alchemy/Infura) for reliable mainnet access.
// TODO: Decode Transfer event logs in executeTrade() to capture real amountOut.
// Currently hard-coded to true — no real transactions will be submitted regardless of DRY_RUN.
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
        "[Executor] strategy/proposal and critic/critique must be in shared memory first"
      );
    }

    if (!critique.approved) {
      logger.warn(
        `[Executor] Critic rejected trade — skipping execution. Issues: ${critique.issues.join("; ")}`
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
        skipped
      );
      return skipped;
    }

    const cfg = getConfig();

    if (SIMULATION_ONLY || cfg.DRY_RUN) {
      if (SIMULATION_ONLY && !cfg.DRY_RUN) {
        logger.warn(
          "[Executor] SIMULATION_ONLY guard is active — ignoring DRY_RUN=false. No real trade will be submitted."
        );
      }
      return await this.simulateTrade(strategy);
    }

    return await this.executeTrade(strategy);
  }

  // ── Simulation (DRY_RUN=true) ───────────────────────────────────────────────

  private async simulateTrade(strategy: TradeStrategy): Promise<ExecutionResult> {
    logger.info(
      `[Executor] DRY RUN — simulating ${strategy.tokenInSymbol}→${strategy.tokenOutSymbol}`
    );

    try {
      const wallet = this.getWallet();
      const router = new ethers.Contract(
        UNISWAP.SWAP_ROUTER_02,
        SWAP_ROUTER_ABI,
        wallet
      );

      const params = {
        tokenIn: strategy.tokenIn,
        tokenOut: strategy.tokenOut,
        fee: strategy.poolFee,
        recipient: wallet.address,
        amountIn: strategy.amountInWei,
        amountOutMinimum: strategy.minAmountOutWei,
        sqrtPriceLimitX96: 0n,
      };

      // Static call — does not submit, reveals revert reason if it would fail
      const staticSwapFn = router.getFunction("exactInputSingle");
      await staticSwapFn.staticCall(params, {
        value: strategy.tokenInSymbol === "WETH" ? strategy.amountInWei : 0n,
      });

      const result: ExecutionResult = {
        dryRun: true,
        txHash: null,
        success: true,
        amountIn: strategy.amountInWei,
        amountOut: strategy.minAmountOutWei,
        gasUsed: null,
        priceImpactPct: strategy.slippagePct,
        executedAt: Date.now(),
      };

      await this.memory.write(
        ExecutorAgent.MEMORY_KEY,
        this.id,
        this.role,
        result
      );
      logger.info("[Executor] DRY RUN simulation succeeded");
      return result;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error(`[Executor] Simulation failed: ${error}`);
      const result: ExecutionResult = {
        dryRun: true,
        txHash: null,
        success: false,
        amountIn: strategy.amountInWei,
        amountOut: null,
        gasUsed: null,
        priceImpactPct: null,
        executedAt: Date.now(),
        error,
      };
      await this.memory.write(
        ExecutorAgent.MEMORY_KEY,
        this.id,
        this.role,
        result
      );
      return result;
    }
  }

  // ── Live execution (DRY_RUN=false) ─────────────────────────────────────────

  private async executeTrade(strategy: TradeStrategy): Promise<ExecutionResult> {
    logger.info(
      `[Executor] LIVE — executing ${strategy.tokenInSymbol}→${strategy.tokenOutSymbol}`
    );

    let result: ExecutionResult;

    try {
      const wallet = this.getWallet();
      const tokenIn = new ethers.Contract(strategy.tokenIn, ERC20_ABI, wallet);
      const router = new ethers.Contract(
        UNISWAP.SWAP_ROUTER_02,
        SWAP_ROUTER_ABI,
        wallet
      );

      // Approve router if needed
      const allowanceFn = tokenIn.getFunction("allowance");
      const allowance = (await allowanceFn(wallet.address, UNISWAP.SWAP_ROUTER_02)) as bigint;
      const needed = BigInt(strategy.amountInWei);
      if (allowance < needed) {
        logger.info("[Executor] Approving router…");
        const approveFn = tokenIn.getFunction("approve");
        const approveTx = (await approveFn(
          UNISWAP.SWAP_ROUTER_02,
          ethers.MaxUint256
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
      result
    );
    return result;
  }
}
