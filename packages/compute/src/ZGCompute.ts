import { createZGComputeNetworkBroker } from "@0glabs/0g-serving-broker";
import { ethers } from "ethers";
import { getConfig, logger } from "@swarm/shared";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface InferOptions {
  maxTokens?: number;
  temperature?: number;
}

interface ServiceMeta {
  providerAddress: string;
  endpoint: string;
  model: string;
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

  constructor() {
    const cfg = getConfig();
    this.provider = new ethers.JsonRpcProvider(cfg.ZG_CHAIN_RPC);
    this.wallet = new ethers.Wallet(cfg.ZG_PRIVATE_KEY, this.provider);
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

    // Ensure ledger funded
    try {
      await broker.ledger.getLedger();
      logger.info("[Compute] Ledger funded ✓");
    } catch {
      logger.info("[Compute] Depositing 1 OG to ledger…");
      await broker.ledger.depositFund(1);
    }

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
    const headers = (await broker.inference.getRequestHeaders(
      svc.providerAddress,
    )) as unknown as Record<string, string>;

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
    const headers = (await broker.inference.getRequestHeaders(
      svc.providerAddress,
    )) as unknown as Record<string, string>;

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
      throw new Error(`[Compute] Stream failed ${res.status}: ${text}`);
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

  // ── JSON inference ──────────────────────────────────────────────────────────

  async inferJSON<T>(
    systemPrompt: string,
    userPrompt: string,
    opts: InferOptions = {},
  ): Promise<T> {
    const raw = await this.infer(systemPrompt, userPrompt, opts);

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
