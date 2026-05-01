import { createZGComputeNetworkBroker } from "@0glabs/0g-serving-broker";
import { ethers } from "ethers";
import { getConfig, logger } from "@swarm/shared";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface InferOptions {
  maxTokens?: number;
  temperature?: number;
  /** Called for every SSE token chunk as it arrives from 0G compute.
   *  Use this to forward the stream to an HTTP client while inferJSON
   *  simultaneously accumulates the full response and saves it. */
  onChunk?: (chunk: string) => void;
}

interface ServiceMeta {
  providerAddress: string;
  endpoint: string;
  model: string;
}

/**
 * Thrown when the 0G Compute ledger balance for a managed wallet drops below
 * the minimum threshold. The orchestrator surfaces this to the frontend so the
 * user can top up their managed wallet address.
 */
export class LedgerLowError extends Error {
  constructor(
    public readonly walletAddress: string,
    public readonly ledgerBalance: number,
    public readonly minRequired: number,
  ) {
    super(
      `LEDGER_LOW: 0G Compute ledger for ${walletAddress} has ${ledgerBalance.toFixed(4)} OG` +
        ` — please deposit ≥${minRequired} OG to your managed wallet to continue.`,
    );
    this.name = "LedgerLowError";
  }
}

// Minimum ledger OG required before an agent session can start.
const MIN_LEDGER_OG = 3;

// ─── ZGCompute ─────────────────────────────────────────────────────────────────

/**
 * Thin wrapper around the 0G Compute Network broker for verifiable LLM inference.
 * One instance is created per process and shared across all agent packages.
 */
export class ZGCompute {
  private readonly provider: ethers.JsonRpcProvider;
  private readonly wallet: ethers.Wallet;
  private service: ServiceMeta | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private broker: any | null = null;

  constructor(privateKeyOverride?: string) {
    const cfg = getConfig();
    this.provider = new ethers.JsonRpcProvider(cfg.ZG_CHAIN_RPC);
    this.wallet = new ethers.Wallet(
      privateKeyOverride ?? cfg.ZG_PRIVATE_KEY,
      this.provider,
    );
  }

  async init(): Promise<void> {
    logger.info("[Compute] Connecting to 0G Compute Network…");
    this.broker = await createZGComputeNetworkBroker(this.wallet);
    const broker = this.broker;

    const services = await broker.inference.listService();
    const chatbots = services.filter(
      (s: { serviceType: string }) => s.serviceType === "chatbot",
    );
    if (chatbots.length === 0)
      throw new Error("[Compute] No chatbot services found on 0G network");

    // Some service listings include the endpoint URL directly
    const chosen = chatbots[0] as {
      provider: string;
      model: string;
      url?: string;
      endpoint?: string;
    };
    logger.info(
      `[Compute] Provider=${chosen.provider.slice(0, 10)}…  model=${chosen.model}`,
    );
    console.log(
      `\n🤖  0G Compute — selected model: \x1b[36m${chosen.model}\x1b[0m  (provider ${chosen.provider.slice(0, 10)}…)\n`,
    );

    // Check ledger balance — throws LedgerLowError if below minimum
    await this.checkLedger();

    // Both acknowledgeProviderSigner and getServiceMetadata can hang — cap each at 8 s
    const withTimeout = <T>(
      p: Promise<T>,
      ms: number,
      fallback: T,
    ): Promise<T> =>
      Promise.race([
        p,
        new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
      ]);

    // Acknowledge provider (already-acked is fine, timeout is safe)
    await withTimeout(
      (
        broker.inference.acknowledgeProviderSigner(
          chosen.provider,
        ) as Promise<unknown>
      ).catch(() => null),
      8_000,
      null,
    );

    const listingEndpoint: string = chosen.url ?? chosen.endpoint ?? "";
    const meta = await withTimeout(
      broker.inference.getServiceMetadata(chosen.provider) as Promise<{
        endpoint: string;
        model: string;
      }>,
      8_000,
      { endpoint: listingEndpoint, model: chosen.model },
    );

    this.service = {
      providerAddress: chosen.provider,
      endpoint: meta.endpoint || listingEndpoint,
      model: meta.model || chosen.model,
    };

    logger.info(
      `[Compute] Ready — endpoint=${this.service.endpoint || "(unknown)"}  model=${this.service.model}`,
    );
    console.log(
      `✅  0G Compute ready — model: \x1b[32m${this.service.model}\x1b[0m  endpoint: ${this.service.endpoint || "(unknown)"}\n`,
    );
  }

  // ── Ledger balance ───────────────────────────────────────────────────────────

  /** Returns the current 0G Compute ledger balance in OG tokens, or 0 on error. */
  async getLedgerBalance(): Promise<number> {
    const broker = this.broker;
    if (!broker) return 0;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ledger = await (broker.ledger.getLedger() as Promise<any>);
      const raw: unknown =
        ledger?.balance ??
        ledger?.totalBalance ??
        ledger?.availableBalance ??
        ledger?.[0] ??
        0;
      if (typeof raw === "bigint") return parseFloat(ethers.formatEther(raw));
      if (typeof raw === "string")
        return parseFloat(ethers.formatEther(BigInt(raw)));
      return Number(raw);
    } catch {
      return 0;
    }
  }

  /**
   * Checks the ledger balance and throws `LedgerLowError` if below MIN_LEDGER_OG.
   * Called during `init()` — inference never starts silently with an empty ledger.
   */
  private async checkLedger(): Promise<void> {
    const balance = await this.getLedgerBalance();
    logger.info(`[Compute] Ledger balance: ${balance.toFixed(4)} OG`);
    if (balance < MIN_LEDGER_OG) {
      throw new LedgerLowError(this.wallet.address, balance, MIN_LEDGER_OG);
    }
    logger.info(`[Compute] Ledger has ${balance.toFixed(4)} OG ✓`);
  }

  /**
   * Deposits `amount` OG tokens into this wallet's 0G Compute ledger.
   * If no ledger exists yet, one is created with the given balance.
   * The broker must be initialised first (call `init()` before this, or
   * call this on a freshly-created broker via `_initBrokerOnly()`).
   *
   * @param amount - Amount in OG tokens (not wei).
   */
  async fundLedger(amount: number): Promise<void> {
    if (!this.broker) {
      // Initialise broker without running the ledger check so we can top up
      // even when the ledger is currently below MIN_LEDGER_OG.
      await this._initBrokerOnly();
    }
    const broker = this.broker!;
    try {
      // Try depositing to an existing ledger first.
      await (broker.ledger.depositFund(amount) as Promise<void>);
      logger.info(
        `[Compute] Deposited ${amount} OG into ledger for ${this.wallet.address}`,
      );
    } catch (depositErr) {
      // If no ledger exists yet, create one.
      const msg =
        depositErr instanceof Error ? depositErr.message : String(depositErr);
      if (/no ledger|ledger not found|does not exist/i.test(msg)) {
        logger.info(
          `[Compute] No ledger found — creating new ledger with ${amount} OG for ${this.wallet.address}`,
        );
        await (broker.ledger.addLedger(amount) as Promise<void>);
      } else {
        throw depositErr;
      }
    }
  }

  /**
   * Initialises only the broker (no service discovery, no ledger check).
   * Used internally by `fundLedger()` so we can top up without triggering
   * the usual `LedgerLowError` gate.
   */
  private async _initBrokerOnly(): Promise<void> {
    this.broker = await createZGComputeNetworkBroker(this.wallet);
  }

  // ── Non-streaming inference ─────────────────────────────────────────────────

  async infer(
    systemPrompt: string,
    userPrompt: string,
    opts: InferOptions = {},
  ): Promise<string> {
    const svc = await this.requireInit();
    const broker =
      this.broker ?? (await createZGComputeNetworkBroker(this.wallet));

    let headers: Record<string, string>;
    try {
      await (
        broker.inference.acknowledgeProviderSigner(
          svc.providerAddress,
        ) as Promise<unknown>
      ).catch(() => null);
      headers = (await broker.inference.getRequestHeaders(
        svc.providerAddress,
      )) as unknown as Record<string, string>;
    } catch (err) {
      // Rethrow — LedgerLowError is handled upstream by the orchestrator.
      throw err;
    }

    const body = JSON.stringify({
      model: svc.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: opts.maxTokens ?? 2048,
      temperature: opts.temperature ?? 0.3,
    });

    const res = await fetch(`${svc.endpoint}/chat/completions`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`[Compute] Inference failed ${res.status}: ${text}`);
    }

    const json = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
    };

    const content = json.choices[0]?.message?.content;
    if (!content) throw new Error("[Compute] Empty response from inference");
    return content;
  }

  // ── Streaming inference ─────────────────────────────────────────────────────

  async *inferStream(
    systemPrompt: string,
    userPrompt: string,
    opts: InferOptions = {},
  ): AsyncGenerator<string> {
    const svc = await this.requireInit();
    const broker =
      this.broker ?? (await createZGComputeNetworkBroker(this.wallet));

    let headers: Record<string, string>;
    try {
      await (
        broker.inference.acknowledgeProviderSigner(
          svc.providerAddress,
        ) as Promise<unknown>
      ).catch(() => null);
      headers = (await broker.inference.getRequestHeaders(
        svc.providerAddress,
      )) as unknown as Record<string, string>;
    } catch (err) {
      // Rethrow — LedgerLowError is handled upstream by the orchestrator.
      throw err;
    }

    const body = JSON.stringify({
      model: svc.model,
      stream: true,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: opts.maxTokens ?? 2048,
      temperature: opts.temperature ?? 0.3,
    });

    const res = await fetch(`${svc.endpoint}/chat/completions`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body,
    });

    if (!res.ok || !res.body) {
      const text = await res.text();
      logger.warn(
        `[Compute] Stream failed ${res.status}: ${text}. Falling back to non-stream path.`,
      );
      const fallback = await this.infer(systemPrompt, userPrompt, opts);
      if (fallback) yield fallback;
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") return;
        try {
          const parsed = JSON.parse(data) as {
            choices: Array<{ delta: { content?: string } }>;
          };
          const delta = parsed.choices[0]?.delta?.content;
          if (delta) yield delta;
        } catch {
          // malformed chunk — skip
        }
      }
    }
  }

  // ── JSON inference (collects streaming chunks then parses) ──────────────────

  async inferJSON<T>(
    systemPrompt: string,
    userPrompt: string,
    opts: InferOptions = {},
  ): Promise<T> {
    let raw = "";
    try {
      for await (const chunk of this.inferStream(
        systemPrompt,
        userPrompt,
        opts,
      )) {
        raw += chunk;
        opts.onChunk?.(chunk);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(
        `[Compute] Stream path failed (${message}). Falling back to non-stream inference.`,
      );
      raw = await this.infer(systemPrompt, userPrompt, opts);
    }

    // 1. Strip markdown code fences if present
    const stripped = raw
      .replace(/^```(?:json)?\s*/m, "")
      .replace(/\s*```\s*$/m, "")
      .trim();

    // 2. Extract the outermost JSON object (first { to matching last })
    const firstBrace = stripped.indexOf("{");
    const lastBrace = stripped.lastIndexOf("}");
    const jsonStr =
      firstBrace !== -1 && lastBrace > firstBrace
        ? stripped.slice(firstBrace, lastBrace + 1)
        : stripped;

    // 3. Try raw parse first, then apply cleanup passes
    const tryParse = (s: string): T => JSON.parse(s) as T;
    try {
      return tryParse(jsonStr);
    } catch {
      // Cleanup: remove trailing commas, JS-style comments, fix missing commas between properties
      const cleaned = jsonStr
        .replace(/,\s*([}\]])/g, "$1") // trailing commas
        .replace(/\/\/[^\n]*/g, "") // // comments
        .replace(/\/\*[\s\S]*?\*\//g, "") // /* comments */
        .replace(/(["'\d\]}\w])\s*\n\s*(")/g, "$1,\n$2"); // missing commas between props
      try {
        return tryParse(cleaned);
      } catch {
        // Last resort: truncate to last valid closing brace
        for (
          let i = cleaned.lastIndexOf("}");
          i > 0;
          i = cleaned.lastIndexOf("}", i - 1)
        ) {
          try {
            return tryParse(cleaned.slice(0, i + 1));
          } catch {
            /* continue */
          }
        }
        throw new Error(
          `[ZGCompute] Failed to parse JSON from LLM response: ${cleaned.slice(0, 100)}…`,
        );
      }
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private async requireInit(): Promise<ServiceMeta> {
    if (!this.service) await this.init();
    const svc = this.service;
    if (!svc) throw new Error("[Compute] init() failed to set service");
    return svc;
  }
}
