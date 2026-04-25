import {
  Indexer,
  KvClient,
  StorageNode,
  Batcher,
  StreamDataBuilder,
  FixedPriceFlow__factory,
} from "@0glabs/0g-ts-sdk";
import type { FixedPriceFlow } from "@0glabs/0g-ts-sdk";
import { ethers } from "ethers";
import { getConfig, logger } from "@swarm/shared";

// ─── ZGStorage ────────────────────────────────────────────────────────────────
//
// Thin, production-ready wrapper around 0G Storage that:
//  • Writes agent blackboard entries via the 0G KV stream (Batcher + StreamDataBuilder)
//  • Reads back entries via KvClient for cross-cycle persistence / audit
//
// Each write is namespaced under a fixed STREAM_ID so all swarm agents share
// the same logical KV namespace on the 0G network.
//
// The StorageBackend interface expected by BlackboardMemory is satisfied by
// the public `store(id, tag, data)` method which returns the 0G root hash.
// ─────────────────────────────────────────────────────────────────────────────

// A deterministic stream ID derived from the project name (32-byte hex string).
// In production you would register a real stream; this acts as a well-known default.
const STREAM_ID =
  "0x756e6973776170737761726d5f626c61636b626f6172640000000000000000"; // "uniswapswarm_blackboard" padded

export class ZGStorage {
  private readonly indexer: Indexer;
  private readonly kvClient: KvClient;
  private readonly wallet: ethers.Wallet;
  private readonly provider: ethers.JsonRpcProvider;
  private storageNodes: StorageNode[] = [];
  private flow: FixedPriceFlow | null = null;
  private ready = false;

  constructor() {
    const cfg = getConfig();
    this.provider = new ethers.JsonRpcProvider(cfg.ZG_CHAIN_RPC);
    this.wallet = new ethers.Wallet(cfg.ZG_PRIVATE_KEY, this.provider);
    this.indexer = new Indexer(cfg.ZG_INDEXER_RPC);
    this.kvClient = new KvClient(cfg.ZG_STORAGE_RPC);
  }

  // ── Init ────────────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    const cfg = getConfig();
    logger.info("[ZGStorage] Connecting to 0G Storage network…");

    // Connect to the on-chain flow contract
    this.flow = FixedPriceFlow__factory.connect(
      cfg.ZG_FLOW_CONTRACT,
      this.wallet
    );

    // Discover storage nodes via the indexer (replica = 1 is enough for agent memory)
    const [nodes, err] = await this.indexer.selectNodes(1);
    if (err || nodes.length === 0) {
      throw new Error(
        `[ZGStorage] Failed to discover storage nodes: ${err?.message ?? "none found"}`
      );
    }
    this.storageNodes = nodes;
    this.ready = true;
    logger.info(
      `[ZGStorage] Ready — ${nodes.length} node(s), flow=${cfg.ZG_FLOW_CONTRACT.slice(0, 10)}…`
    );
  }

  // ── Write ───────────────────────────────────────────────────────────────────

  /**
   * Serialize `data` to JSON and write it to the 0G KV stream under
   * the compound key  `<agentId>/<tag>`.
   *
   * Returns the 0G rootHash string on success so it can be stored in
   * the MemoryEntry as an immutable audit reference.
   */
  async store(agentId: string, tag: string, data: unknown): Promise<string> {
    this.assertReady();

    const key = `${agentId}/${tag}`;
    const valueBytes = new TextEncoder().encode(JSON.stringify(data));
    const keyBytes = new TextEncoder().encode(key);

    const builder = new StreamDataBuilder(Date.now());
    builder.set(STREAM_ID, keyBytes, valueBytes);

    const batcher = new Batcher(
      Date.now(),
      this.storageNodes,
      this.flow!,
      (await this.provider.getNetwork()).name
    );

    // Copy the builder state into the batcher's own builder
    batcher.streamDataBuilder = builder;

    const [result, err] = await batcher.exec();
    if (err) {
      throw new Error(`[ZGStorage] Write failed for key "${key}": ${err.message}`);
    }

    logger.info(
      `[ZGStorage] Wrote "${key}" → rootHash=${result.rootHash.slice(0, 20)}…`
    );
    return result.rootHash;
  }

  // ── Read ────────────────────────────────────────────────────────────────────

  /**
   * Read back a previously stored entry by `agentId/tag`.
   * Returns the parsed value or null if not found.
   */
  async retrieve<T = unknown>(agentId: string, tag: string): Promise<T | null> {
    this.assertReady();

    const key = `${agentId}/${tag}`;
    const keyBytes = new TextEncoder().encode(key);

    try {
      const value = await this.kvClient.getValue(STREAM_ID, keyBytes);
      if (!value || !value.data) return null;

      const text = Buffer.from(value.data, "base64").toString("utf8");
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private assertReady(): void {
    if (!this.ready) {
      throw new Error("[ZGStorage] Not initialised — call init() first");
    }
  }
}
