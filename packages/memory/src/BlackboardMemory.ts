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

  constructor(storage?: ZGStorage) {
    this.storage = storage ?? null;
  }

  // ── Write ───────────────────────────────────────────────────────────────────

  async write(
    key: string,
    agentId: string,
    role: string,
    value: unknown,
  ): Promise<MemoryEntry> {
    const json = JSON.stringify(value);
    const hash = this.storage
      ? await this.storage.store(agentId, key, value).catch(() => {
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
    logger.info(`[Memory] ${role} wrote "${key}"  hash=${hash.slice(0, 20)}…`);
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
  }

  get size(): number {
    return this.cache.size;
  }
}
