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
    const storageKey = this.scopedKey(key);
    const hash = await this.resolveHash(agentId, role, storageKey, value);
    const entry = this.buildEntry(key, agentId, role, value, hash);

    this.cache.set(key, entry);
    logger.info(
      `[Memory${this.namespace ? `:${this.namespace}` : ""}] ${role} wrote "${key}"  hash=${hash.slice(0, 20)}…`,
    );
    return entry;
  }

  private async resolveHash(
    agentId: string,
    role: string,
    storageKey: string,
    value: unknown,
  ): Promise<string> {
    if (!this.storage) return this.computeLocalHash(value);
    return this.storage
      .store(agentId, storageKey, value, { role })
      .catch(() => this.computeLocalHash(value));
  }

  private computeLocalHash(value: unknown): string {
    const json = JSON.stringify(value);
    const digest = crypto.createHash("sha256").update(json).digest("hex");
    return `local:${digest}`;
  }

  private buildEntry(
    key: string,
    agentId: string,
    role: string,
    value: unknown,
    hash: string,
  ): MemoryEntry {
    return {
      key,
      agentId,
      role,
      value,
      hash,
      ts: Date.now(),
    };
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
    if (this.shouldSkipHydration()) return 0;
    const persisted = await this.fetchPersistedRecords();
    const loaded = this.hydrateCache(persisted);
    this.hydrated = true;
    this.logHydrationResult(loaded);
    return loaded;
  }

  private shouldSkipHydration(): boolean {
    return !this.storage || this.hydrated;
  }

  private async fetchPersistedRecords(): Promise<
    Array<{
      tag: string;
      agentId: string;
      role: string;
      data: unknown;
      rootHash: string;
      ts: number;
    }>
  > {
    if (!this.storage) return [];
    const prefix = this.namespace ? `${this.namespace}/` : "";
    return (await this.storage.listByPrefix(prefix)) ?? [];
  }

  private hydrateCache(
    persisted: Array<{
      tag: string;
      agentId: string;
      role: string;
      data: unknown;
      rootHash: string;
      ts: number;
    }>,
  ): number {
    let loaded = 0;
    for (const item of persisted) {
      const key = this.toCacheKey(item.tag);
      if (!key) continue;
      this.cache.set(
        key,
        this.buildHydratedEntry(
          key,
          item.agentId,
          item.role,
          item.data,
          item.rootHash,
          item.ts,
        ),
      );
      loaded += 1;
    }
    return loaded;
  }

  private toCacheKey(tag: string): string {
    return this.namespace ? tag.replace(`${this.namespace}/`, "") : tag;
  }

  private buildHydratedEntry(
    key: string,
    agentId: string,
    role: string,
    value: unknown,
    hash: string,
    ts: number,
  ): MemoryEntry {
    return { key, agentId, role, value, hash, ts };
  }

  private logHydrationResult(loaded: number): void {
    if (loaded <= 0) return;
    logger.info(
      `[Memory${this.namespace ? `:${this.namespace}` : ""}] hydrated ${loaded} key(s) from persistent index`,
    );
  }
}
