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
  contextLength?: number;
  maxCompletionTokens?: number;
}

interface ChatbotService {
  provider: string;
  model: string;
  url?: string;
  endpoint?: string;
  modelInfo?: {
    context_length?: number;
    max_completion_tokens?: number;
  };
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

/**
 * Thrown when provider sub-account funding is required before inference can run.
 * This is different from `LedgerLowError`: it can happen after init when the
 * provider sub-account has not been funded yet.
 */
export class SubAccountFundingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubAccountFundingError";
  }
}

// Minimum ledger OG required before an agent session can start.
// Set to 5 to account for provider sub-account auto-funding (~2 OG transfer-fund fee)
// plus a buffer to ensure inference operations succeed after sub-account initialization.
const MIN_LEDGER_OG = 5;

function normalizeErrMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isSubAccountFundingErrorMessage(message: string): boolean {
  return (
    /sub-account not found/i.test(message) ||
    /initialize it by transferring funds/i.test(message) ||
    /transfer-fund/i.test(message) ||
    /requires\s+[\d.]+\s*0g\s+in your ledger/i.test(message) ||
    /ledger available balance is insufficient/i.test(message)
  );
}

function isSignerNotAcknowledgedMessage(message: string): boolean {
  return /service not acknowledge the tee signer/i.test(message);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toSubAccountFundingError(err: unknown): SubAccountFundingError {
  const message = normalizeErrMessage(err);
  return new SubAccountFundingError(
    `0G provider sub-account is not funded yet. ${message} ` +
      `Fund your ledger/sub-account and retry (example: 0g-compute-cli deposit --amount 2).`,
  );
}

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

    const cfg = getConfig();
    const services = await broker.inference.listServiceWithDetail(0, 50, true);
    const chatbots = services.filter(
      (s: { serviceType: string }) => s.serviceType === "chatbot",
    ) as ChatbotService[];
    if (chatbots.length === 0)
      throw new Error("[Compute] No chatbot services found on 0G network");

    const orderedCandidates = chatbots;

    let chosen = orderedCandidates[0] as ChatbotService;
    let acknowledgedChosen = false;
    for (const candidate of orderedCandidates) {
      try {
        const status = (await broker.inference.checkProviderSignerStatus(
          candidate.provider,
        )) as { isAcknowledged?: boolean };
        if (status?.isAcknowledged) {
          chosen = candidate;
          acknowledgedChosen = true;
          break;
        }
      } catch (err) {
        logger.warn(
          `[Compute] Provider signer status check failed for ${candidate.provider.slice(0, 10)}…: ${normalizeErrMessage(err)}`,
        );
      }
    }

    if (!acknowledgedChosen) {
      logger.warn(
        "[Compute] No chatbot provider reports an acknowledged TEE signer; requests may fail until the provider is acknowledged by the service owner.",
      );
    }

    // Some service listings include the endpoint URL directly
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

    const modelOverride = cfg.ZG_INFERENCE_MODEL.trim();
    const service: ServiceMeta = {
      providerAddress: chosen.provider,
      endpoint: meta.endpoint || listingEndpoint,
      model: modelOverride || meta.model || chosen.model,
      ...(typeof chosen.modelInfo?.context_length === "number"
        ? { contextLength: chosen.modelInfo.context_length }
        : {}),
      ...(typeof chosen.modelInfo?.max_completion_tokens === "number"
        ? { maxCompletionTokens: chosen.modelInfo.max_completion_tokens }
        : {}),
    };
    this.service = service;

    if (modelOverride) {
      logger.info(`[Compute] ZG_INFERENCE_MODEL override → ${modelOverride}`);
    }

    logger.info(
      `[Compute] Ready — endpoint=${service.endpoint || "(unknown)"}  model=${service.model}`,
    );
    if (service.contextLength || service.maxCompletionTokens) {
      logger.info(
        `[Compute] Provider limits — context=${service.contextLength ?? "unknown"} max_completion=${service.maxCompletionTokens ?? "unknown"}`,
      );
    }
    console.log(
      `✅  0G Compute ready — model: \x1b[32m${service.model}\x1b[0m  endpoint: ${service.endpoint || "(unknown)"}\n`,
    );
  }

  private resolveMaxTokens(svc: ServiceMeta, opts: InferOptions): number {
    const cfg = getConfig();
    const requested = opts.maxTokens ?? cfg.AGENT_MAX_INFER_TOKENS;
    const remoteCap = svc.maxCompletionTokens ?? svc.contextLength;
    if (!remoteCap || requested <= remoteCap) {
      return requested;
    }

    logger.warn(
      `[Compute] Clamping maxTokens from ${requested} to provider-advertised cap ${remoteCap}`,
    );
    return remoteCap;
  }

  // ── Ledger balance ───────────────────────────────────────────────────────────

  /**
   * Returns the usable 0G Compute ledger balance in OG tokens (availableBalance),
   * or 0 on error. We prioritize available balance because provider auto-funding
   * draws from available funds, not total ledger value.
   */
  async getLedgerBalance(): Promise<number> {
    const broker = this.broker;
    if (!broker) return 0;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ledger = await (broker.ledger.getLedger() as Promise<any>);
      const raw: unknown =
        ledger?.availableBalance ??
        ledger?.balance ??
        ledger?.totalBalance ??
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
   * **Important:** The amount must account for provider sub-account auto-funding,
   * which requires at least 2 OG available after deposit. Recommend funding with
   * at least 5 OG to ensure the provider sub-account can be initialized.
   *
   * @param amount - Amount in OG tokens (not wei). Minimum 5 recommended (2+ reserved for provider sub-account).
   */
  async fundLedger(amount: number): Promise<void> {
    if (amount < 2) {
      throw new Error(
        `fundLedger(${amount}): Insufficient amount. ` +
          `Minimum 2 OG required, but 5+ recommended to account for provider sub-account initialization. ` +
          `Provider auto-funding needs 2 OG available for transfer-fund operations.`,
      );
    }

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
        `[Compute] Deposited ${amount} OG into main ledger for ${this.wallet.address}`,
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

    // Ensure broker is ready for provider sub-account initialization on next inference
    logger.info(
      `[Compute] Ledger funded. On next inference, provider sub-account will auto-fund ` +
        `if 2+ OG is available. If provider sub-account errors occur, fund again with 5+ OG.`,
    );
  }

  /**
   * Initialises only the broker (no service discovery, no ledger check).
   * Used internally by `fundLedger()` so we can top up without triggering
   * the usual `LedgerLowError` gate.
   */
  private async _initBrokerOnly(): Promise<void> {
    this.broker = await createZGComputeNetworkBroker(this.wallet);
  }

  private async getRequestHeadersWithSignerAck(
    broker: Awaited<ReturnType<typeof createZGComputeNetworkBroker>>,
    providerAddress: string,
  ): Promise<Record<string, string>> {
    // Provider acknowledgment can race for fresh managed wallets.
    // Retry once before failing the request.
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        await (broker.inference.acknowledgeProviderSigner(
          providerAddress,
        ) as Promise<unknown>);
        const headers = (await broker.inference.getRequestHeaders(
          providerAddress,
        )) as unknown as Record<string, string>;
        return headers;
      } catch (err) {
        lastErr = err;
        const message = normalizeErrMessage(err);
        if (attempt === 1 && isSignerNotAcknowledgedMessage(message)) {
          logger.warn(
            "[Compute] Provider signer not acknowledged yet; retrying header initialization once",
          );
          await delay(500);
          continue;
        }
        if (isSubAccountFundingErrorMessage(message)) {
          throw toSubAccountFundingError(err);
        }
        throw err;
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new Error("[Compute] Unable to initialise provider request headers");
  }

  // ── Non-streaming inference ─────────────────────────────────────────────────

  async infer(
    systemPrompt: string,
    userPrompt: string,
    opts: InferOptions = {},
  ): Promise<string> {
    const svc = await this.requireInit();
    const maxTokens = this.resolveMaxTokens(svc, opts);
    const broker =
      this.broker ?? (await createZGComputeNetworkBroker(this.wallet));

    const body = JSON.stringify({
      model: svc.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: maxTokens,
      temperature: opts.temperature ?? 0.3,
    });

    let lastFailure = "[Compute] Inference failed: unknown error";
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const headers = await this.getRequestHeadersWithSignerAck(
        broker,
        svc.providerAddress,
      );

      const res = await fetch(`${svc.endpoint}/chat/completions`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body,
      });

      if (res.ok) {
        const json = (await res.json()) as {
          choices: Array<{ message: { content: string } }>;
        };
        const content = json.choices[0]?.message?.content;
        if (!content)
          throw new Error("[Compute] Empty response from inference");
        return content;
      }

      const text = await res.text();
      lastFailure = `[Compute] Inference failed ${res.status}: ${text}`;
      if (isSignerNotAcknowledgedMessage(text) && attempt < 3) {
        logger.warn(
          `[Compute] Provider signer not acknowledged yet (attempt ${attempt}/3); retrying inference after backoff`,
        );
        await delay(1200 * attempt);
        continue;
      }
      throw new Error(lastFailure);
    }

    throw new Error(lastFailure);
  }

  // ── Streaming inference ─────────────────────────────────────────────────────

  async *inferStream(
    systemPrompt: string,
    userPrompt: string,
    opts: InferOptions = {},
  ): AsyncGenerator<string> {
    const svc = await this.requireInit();
    const maxTokens = this.resolveMaxTokens(svc, opts);
    const broker =
      this.broker ?? (await createZGComputeNetworkBroker(this.wallet));

    const headers = await this.getRequestHeadersWithSignerAck(
      broker,
      svc.providerAddress,
    );

    const body = JSON.stringify({
      model: svc.model,
      stream: true,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: maxTokens,
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
      const message = normalizeErrMessage(err);
      if (
        err instanceof SubAccountFundingError ||
        isSubAccountFundingErrorMessage(message)
      ) {
        throw err instanceof SubAccountFundingError
          ? err
          : toSubAccountFundingError(err);
      }
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
