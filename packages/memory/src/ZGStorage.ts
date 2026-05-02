import { Indexer, MemData } from "@0gfoundation/0g-ts-sdk";
import type { TransactionOptions } from "@0gfoundation/0g-ts-sdk";
import { ethers } from "ethers";
import { getConfig, logger } from "@swarm/shared";

// Gas limit for the on-chain Flow contract `submit` call.
// Risk agent writes larger payloads (multi-token assessment arrays with on-chain
// flags and proxy details) which require more Merkle segments → more gas.
// 5 M is well within the 0G testnet block limit and handles the biggest payloads.
const ZG_STORAGE_GAS_LIMIT = BigInt(5_000_000);
const ZG_TX_OPTS: TransactionOptions = { gasLimit: ZG_STORAGE_GAS_LIMIT };

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

  constructor(privateKeyOverride?: string) {
    const cfg = getConfig();
    this.chainRpc = cfg.ZG_CHAIN_RPC;
    const provider = new ethers.JsonRpcProvider(cfg.ZG_CHAIN_RPC);
    this.wallet = new ethers.Wallet(
      privateKeyOverride ?? cfg.ZG_PRIVATE_KEY,
      provider,
    );
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
   * Store one blackboard entry in 0G as a JSON blob and return its root hash.
   *
   * `agentId`:
   * - The writer/owner agent id (for example: "planner", "researcher", "risk").
   *
   * `tag`:
   * - The memory key used as the logical lookup label.
   * - In this repo keys follow "<agentId>/<slot>" (for example "planner/plan").
   * - Session scoping is carried inside `tag` via BlackboardMemory namespace.
   *   Orchestrator currently uses `sessions/<sessionId>` as namespace.
   * - Effective key example: "sessions/<sessionId>/planner/plan".
   *
   * `data`:
   * - The payload to persist (string, object, array, etc).
   * - It must be JSON-serializable because it is encoded with JSON.stringify.
   *
   * `meta`:
   * - Optional metadata for higher-level memory semantics.
   * - Current shape is `{ role?: string }` from BlackboardMemory.
   * - It is accepted for interface compatibility, but currently not written.
   *
   * Example:
   * `await storage.store("planner", "sessions/8a2f.../planner/plan", { goals: ["ship-v1"] }, { role: "planner" });`
   */
  async store(
    agentId: string,
    tag: string,
    data: unknown,
    _meta?: { role?: string },
  ): Promise<string> {
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
        undefined,   // uploadOpts — use SDK defaults
        undefined,   // retryOpts  — use SDK defaults
        ZG_TX_OPTS,  // TransactionOptions: explicit gas limit
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

  async listByPrefix(_prefix: string): Promise<PersistedRecord[]> {
    return [];
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private assertReady(): void {
    if (!this.ready) {
      throw new Error("[ZGStorage] Not initialised — call init() first");
    }
  }
}

type PersistedRecord = {
  tag: string;
  agentId: string;
  role: string;
  data: unknown;
  rootHash: string;
  ts: number;
};
