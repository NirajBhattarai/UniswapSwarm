import { Indexer, MemData } from "@0gfoundation/0g-ts-sdk";
import { ethers } from "ethers";
import { getConfig, logger } from "@swarm/shared";

// ─── ZGStorage ────────────────────────────────────────────────────────────────
//
// Thin, production-ready wrapper around 0G Storage that:
//  • Writes agent blackboard entries as raw JSON blobs via 0G file upload
//  • Returns the content root hash (CID) for cross-cycle auditability
//
// The StorageBackend interface expected by BlackboardMemory is satisfied by
// the public `store(id, tag, data)` method which returns the 0G root hash.
// ─────────────────────────────────────────────────────────────────────────────

export class ZGStorage {
  private readonly indexer: Indexer;
  private readonly wallet: ethers.Wallet;
  private readonly chainRpc: string;
  private ready = false;

  constructor() {
    const cfg = getConfig();
    this.chainRpc = cfg.ZG_CHAIN_RPC;
    const provider = new ethers.JsonRpcProvider(cfg.ZG_CHAIN_RPC);
    this.wallet = new ethers.Wallet(cfg.ZG_PRIVATE_KEY, provider);
    this.indexer = new Indexer(cfg.ZG_INDEXER_RPC);
  }

  // ── Init ────────────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    logger.info("[ZGStorage] Connecting to 0G Storage network…");

    // Verify indexer is reachable by selecting nodes
    const [nodes, err] = await this.indexer.selectNodes(1);
    if (err || nodes.length === 0) {
      throw new Error(
        `[ZGStorage] Failed to discover storage nodes: ${err?.message ?? "none found"}`,
      );
    }
    this.ready = true;
    const cfg = getConfig();
    logger.info(
      `[ZGStorage] Ready — ${nodes.length} node(s), flow=${cfg.ZG_FLOW_CONTRACT.slice(0, 10)}…`,
    );
  }

  // ── Write ───────────────────────────────────────────────────────────────────

  /**
   * Serialize `data` to JSON and upload it as a file blob to 0G Storage.
   * Returns the content root hash on success.
   */
  async store(agentId: string, tag: string, data: unknown): Promise<string> {
    this.assertReady();

    const payload = JSON.stringify({ agentId, tag, data });
    const bytes = new TextEncoder().encode(payload);
    const file = new MemData(bytes);

    let rootHash: string | undefined;
    let uploadErr: Error | null = null;
    try {
      const [res, err] = await this.indexer.upload(
        file,
        this.chainRpc,
        this.wallet,
      );
      if (err) {
        uploadErr = new Error(err.message);
      } else if (res && "rootHash" in res) {
        rootHash = res.rootHash;
      } else if (res && "rootHashes" in res && res.rootHashes.length > 0) {
        rootHash = res.rootHashes[0];
      }
    } catch (e: unknown) {
      uploadErr = e instanceof Error ? e : new Error(String(e));
    }

    if (uploadErr) {
      logger.error(
        `[ZGStorage] Write failed for key "${tag}": ${uploadErr.message}`,
      );
      throw uploadErr;
    }

    if (!rootHash) {
      throw new Error(`[ZGStorage] Upload returned no root hash for "${tag}"`);
    }

    logger.info(
      `[ZGStorage] Wrote "${tag}" → rootHash=${rootHash.slice(0, 20)}…`,
    );
    return rootHash;
  }

  // ── Read ────────────────────────────────────────────────────────────────────

  /**
   * Retrieve is not supported in file-upload mode (no KV lookup).
   * Returns null — agents re-fetch from in-memory blackboard instead.
   */
  async retrieve<T = unknown>(
    _agentId: string,
    _tag: string,
  ): Promise<T | null> {
    return null;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private assertReady(): void {
    if (!this.ready) {
      throw new Error("[ZGStorage] Not initialised — call init() first");
    }
  }
}
