import { ethers } from "ethers";
import { BlackboardMemory } from "@swarm/memory";
import { logger, getConfig, UNISWAP_TRADE_API_BASE_URL } from "@swarm/shared";
import type { TradeStrategy, Critique, ExecutionResult } from "@swarm/shared";

// ─── Safety guard ─────────────────────────────────────────────────────────────
// SIMULATION_ONLY=true → pure mock result, no RPC calls, always succeeds.
// Defaults to false so DRY_RUN controls behaviour unless explicitly forced.
const SIMULATION_ONLY =
  process.env.SIMULATION_ONLY === "true" || process.env.SIMULATION_ONLY === "1";

const ETH_ADDRESS_SENTINEL = "0x0000000000000000000000000000000000000000";

type TxRequestLike = {
  to: string;
  data: string;
  value?: string;
};

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
        `[Executor] Critic rejected trade, but executor was explicitly invoked (likely user override). Issues: ${critique.issues.join("; ")}`,
      );
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
      `[Executor] LIVE — executing ${strategy.tokenInSymbol}→${strategy.tokenOutSymbol} via Uniswap Trading API`,
    );

    let result: ExecutionResult;

    try {
      const cfg = getConfig();
      if (!cfg.UNISWAP_API_KEY) {
        throw new Error(
          "UNISWAP_API_KEY is required for live swap execution via Uniswap Trading API",
        );
      }

      const wallet = this.getWallet();

      // 1) Ensure token approval exists for the input token amount.
      const approvalResponse = await this.callTradeApi("check_approval", {
        walletAddress: wallet.address,
        token: strategy.tokenIn,
        amount: strategy.amountInWei,
        chainId: 1,
      });

      const approvalTx = this.extractTxRequest(approvalResponse);
      if (approvalTx) {
        logger.info("[Executor] Approval tx required — submitting approval");
        const approvalReceipt = await this.sendTx(wallet, approvalTx);
        if (approvalReceipt.status !== 1) {
          throw new Error("Approval transaction reverted");
        }
      }

      // 2) Fetch quote with exact input settings.
      const quoteResponse = await this.callTradeApi("quote", {
        tokenIn: strategy.tokenIn,
        tokenOut: strategy.tokenOut,
        amount: strategy.amountInWei,
        type: "EXACT_INPUT",
        tokenInChainId: 1,
        tokenOutChainId: 1,
        swapper: wallet.address,
        slippageTolerance: strategy.slippagePct,
        // Ask API to disable permit signing requirements in this server flow.
        generatePermitAsTransaction: true,
      });

      const quote = this.extractQuote(quoteResponse);
      if (!quote) {
        throw new Error("Trade API /quote did not return a quote payload");
      }

      // 3) Convert quote into executable calldata.
      const swapResponse = await this.callTradeApi("swap", { quote });
      const swapTx = this.extractTxRequest(swapResponse);
      if (!swapTx) {
        throw new Error(
          "Trade API /swap did not return a transaction request (to/data/value)",
        );
      }

      logger.info("[Executor] Submitting swap transaction");
      const receipt = await this.sendTx(wallet, swapTx);
      const txHash = receipt.hash;
      const reverted = receipt.status !== 1;

      const amountOut =
        this.extractOutputAmount(quote) ?? strategy.minAmountOutWei ?? null;
      result = {
        dryRun: false,
        txHash,
        success: !reverted,
        amountIn: strategy.amountInWei,
        amountOut,
        gasUsed: receipt.gasUsed.toString(),
        priceImpactPct:
          typeof quote["priceImpact"] === "number"
            ? (quote["priceImpact"] as number)
            : null,
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

  private async callTradeApi(
    path: "check_approval" | "quote" | "swap",
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const cfg = getConfig();
    const res = await fetch(`${UNISWAP_TRADE_API_BASE_URL}/${path}`, {
      method: "POST",
      headers: {
        "x-api-key": cfg.UNISWAP_API_KEY,
        "x-universal-router-version": "2.0",
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const details = await res.text();
      throw new Error(`Trade API /${path} ${res.status}: ${details}`);
    }

    const parsed = (await res.json()) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error(`Trade API /${path} returned non-object payload`);
    }
    return parsed as Record<string, unknown>;
  }

  private async sendTx(
    wallet: ethers.Wallet,
    txLike: TxRequestLike,
  ): Promise<ethers.TransactionReceipt> {
    const tx = await wallet.sendTransaction({
      to: txLike.to,
      data: txLike.data,
      value: this.parseTxValue(txLike.value),
    });
    logger.info(`[Executor] Tx submitted: ${tx.hash}`);
    const receipt = await tx.wait();
    if (!receipt) {
      throw new Error("Transaction receipt missing");
    }
    return receipt;
  }

  private parseTxValue(raw?: string): bigint {
    if (!raw) return 0n;
    return raw.startsWith("0x") ? BigInt(raw) : BigInt(raw);
  }

  private extractQuote(
    payload: Record<string, unknown>,
  ): Record<string, unknown> | null {
    const quote = payload["quote"];
    if (typeof quote === "object" && quote !== null) {
      return quote as Record<string, unknown>;
    }
    return null;
  }

  private extractOutputAmount(quote: Record<string, unknown>): string | null {
    const output = quote["output"];
    if (typeof output === "object" && output !== null) {
      const amount = (output as Record<string, unknown>)["amount"];
      if (typeof amount === "string" && amount.trim().length > 0) {
        return amount;
      }
    }
    return null;
  }

  private extractTxRequest(
    payload: Record<string, unknown>,
  ): TxRequestLike | null {
    const candidates: unknown[] = [
      payload,
      payload["txRequest"],
      payload["transaction"],
      payload["approval"],
      payload["swap"],
      payload["permitTransaction"],
    ];

    for (const candidate of candidates) {
      const tx = this.asTxRequest(candidate);
      if (tx) return tx;
    }

    // Some API responses nest tx payloads one level deeper.
    for (const value of Object.values(payload)) {
      const tx = this.asTxRequest(value);
      if (tx) return tx;
    }
    return null;
  }

  private asTxRequest(value: unknown): TxRequestLike | null {
    if (typeof value !== "object" || value === null) return null;
    const rec = value as Record<string, unknown>;
    const to = rec["to"];
    const data = rec["data"];
    if (typeof to !== "string" || typeof data !== "string") return null;

    const rawValue = rec["value"];
    const txValue =
      typeof rawValue === "string"
        ? rawValue
        : rawValue == null
          ? undefined
          : String(rawValue);

    // Guard bad payloads that accidentally point to zero-address.
    if (to.toLowerCase() === ETH_ADDRESS_SENTINEL) return null;
    return txValue === undefined ? { to, data } : { to, data, value: txValue };
  }
}
