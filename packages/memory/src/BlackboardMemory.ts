import * as crypto from "crypto";
import { logger } from "@swarm/shared";
import type { MemoryEntry } from "@swarm/shared";
import type { ZGStorage } from "./ZGStorage";

// ─── BlackboardMemory ─────────────────────────────────────────────────────────
//
// In-process key/value store for agent-to-agent communication within a cycle.
// Backed by 0G Storage writes (best-effort) for on-chain audit trail.
// All agents share ONE BlackboardMemory instance per orchestrator cycle.
//
// Keys use the format:  "<agentId>/<slot>"
// e.g.  "planner/plan", "researcher/report", "risk/assessment"
// ─────────────────────────────────────────────────────────────────────────────

export class BlackboardMemory {
  private readonly cache = new Map<string, MemoryEntry>();
  private readonly storage: ZGStorage | null;
  private readonly namespace: string | null;
  private hydrated = false;

  constructor(storage?: ZGStorage, namespace?: string) {
    this.storage = storage ?? null;
    this.namespace = namespace ?? null;
  }

  private scopedKey(key: string): string {
    return this.namespace ? `${this.namespace}/${key}` : key;
  }

  // ── Write ───────────────────────────────────────────────────────────────────

  async write(
    key: string,
    agentId: string,
    role: string,
    value: unknown,
  ): Promise<MemoryEntry> {
    const json = JSON.stringify(value);
    const storageKey = this.scopedKey(key);
    const hash = this.storage
      ? await this.storage.store(agentId, storageKey, value, { role }).catch(() => {
          const h = crypto.createHash("sha256").update(json).digest("hex");
          return `local:${h}`;
        })
      : `local:${crypto.createHash("sha256").update(json).digest("hex")}`;

    const entry: MemoryEntry = {
      key,
      agentId,
      role,
      value,
      hash,
      ts: Date.now(),
    };

    this.cache.set(key, entry);
    logger.info(
      `[Memory${this.namespace ? `:${this.namespace}` : ""}] ${role} wrote "${key}"  hash=${hash.slice(0, 20)}…`,
    );
    return entry;
  }

  // ── Read ────────────────────────────────────────────────────────────────────

  read(key: string): MemoryEntry | undefined {
    return this.cache.get(key);
  }

  /**
   * Typed read — returns the stored value cast to T, or undefined if not yet written.
   * Agents use this to pull prior agent outputs directly from 0G-backed memory.
   */
  readValue<T>(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    return entry.value as T;
  }

  readAll(): MemoryEntry[] {
    return [...this.cache.values()].sort((a, b) => a.ts - b.ts);
  }

  /**
   * Return a formatted context block for LLM prompts.
   * Each agent passes its own key as excludeKey so it doesn't read its own slot.
   */
  contextFor(excludeKey?: string): string {
    const relevant = this.readAll().filter((e) => e.key !== excludeKey);
    if (relevant.length === 0) return "";
    const sections = relevant.map((e) => {
      const payload =
        typeof e.value === "string"
          ? e.value
          : JSON.stringify(e.value, null, 2);
      return `### ${e.role}\n${payload}`;
    });
    return `\n\n## Shared swarm memory (previous agents)\n${sections.join("\n\n")}`;
  }

  /** Drop all entries — call at the start of each cycle */
  clear(): void {
    this.cache.clear();
    this.hydrated = false;
  }

  get size(): number {
    return this.cache.size;
  }

  async hydrateFromStorage(): Promise<number> {
    if (!this.storage) return 0;
    if (this.hydrated) return 0;

    const prefix = this.namespace ? `${this.namespace}/` : "";
    const persisted = await this.storage.listByPrefix(prefix);
    let loaded = 0;

    for (const item of persisted) {
      const key = this.namespace
        ? item.tag.replace(`${this.namespace}/`, "")
        : item.tag;
      if (!key) continue;
      this.cache.set(key, {
        key,
        agentId: item.agentId,
        role: item.role,
        value: item.data,
        hash: item.rootHash,
        ts: item.ts,
      });
      loaded += 1;
    }

    this.hydrated = true;
    if (loaded > 0) {
      logger.info(
        `[Memory${this.namespace ? `:${this.namespace}` : ""}] hydrated ${loaded} key(s) from persistent index`,
      );
    }
    return loaded;
  }
}
