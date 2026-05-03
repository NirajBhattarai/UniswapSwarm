/**
 * Static descriptors for the Uniswap Swarm A2A agent fleet.
 *
 * Mirrors `apps/orchestrator/src/a2aAgents.ts`. Keep these arrays in sync.
 */

export { SWARM_AGENTS } from "../constants/swarm-agents";
export type { SwarmAgentId, SwarmAgentDescriptor } from "../constants/swarm-agents";

import { SWARM_AGENTS } from "../constants/swarm-agents";
import type { SwarmAgentId, SwarmAgentDescriptor } from "../constants/swarm-agents";

// Base URL for A2A agent endpoints.
// Server deployments (e.g. Netlify) often only set NEXT_PUBLIC_ORCHESTRATOR_URL,
// so we fall back to it before localhost defaults.
const ORCHESTRATOR_BASE_URL =
  process.env.ORCHESTRATOR_URL ??
  process.env.NEXT_PUBLIC_ORCHESTRATOR_URL ??
  "http://localhost:4000";

export const SWARM_AGENTS_BY_CARD_NAME: Record<string, SwarmAgentDescriptor> =
  Object.fromEntries(SWARM_AGENTS.map((a) => [a.cardName, a]));

export const SWARM_AGENTS_BY_ID: Record<SwarmAgentId, SwarmAgentDescriptor> =
  Object.fromEntries(SWARM_AGENTS.map((a) => [a.id, a])) as Record<
    SwarmAgentId,
    SwarmAgentDescriptor
  >;

export function getSwarmAgentUrls(): string[] {
  return SWARM_AGENTS.map((agent) => {
    const fromEnv = process.env[agent.envVar];
    if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim();
    // All agents now run on the same port with route-based endpoints
    return `${ORCHESTRATOR_BASE_URL}${agent.route}`;
  });
}

type EnsAgentRecord = {
  agentId: string;
  url: string | null;
};

// Cache ENS records in-process for 5 minutes so we don't hit the orchestrator
// (and transitively Sepolia) on every CopilotKit request.
const ENS_CACHE_TTL_MS = 5 * 60 * 1000;
let _ensCache: { records: EnsAgentRecord[]; expiresAt: number } | null = null;

/**
 * Resolve agent URLs using ENS as the primary source of truth.
 *
 * Fetches live ENS records from the orchestrator's /api/ens/agents endpoint
 * (which reads text[url] from each *.uniswapswarm.eth subdomain on Sepolia).
 * Results are cached in-process for 5 minutes to avoid an RPC round-trip on
 * every request. Falls back to env vars or the default base-URL pattern if
 * ENS resolution fails or a record has no url set.
 */
export async function resolveSwarmAgentUrls(): Promise<string[]> {
  let ensRecords: EnsAgentRecord[] = [];

  try {
    // Return cached records if still fresh
    if (_ensCache && Date.now() < _ensCache.expiresAt) {
      ensRecords = _ensCache.records;
    } else {
      const res = await fetch(`${ORCHESTRATOR_BASE_URL}/api/ens/agents`, {
        cache: "no-store",
        signal: AbortSignal.timeout(4000),
      });
      if (res.ok) {
        const json = (await res.json()) as { agents?: EnsAgentRecord[] };
        ensRecords = json.agents ?? [];
        _ensCache = { records: ensRecords, expiresAt: Date.now() + ENS_CACHE_TTL_MS };
      }
    }
  } catch {
    // ENS lookup unavailable — fall back to env / default pattern below
  }

  return SWARM_AGENTS.map((agent) => {
    // 1. ENS text[url] — the on-chain source of truth
    const ensUrl = ensRecords.find((r) => r.agentId === agent.id)?.url;
    if (ensUrl && ensUrl.trim().length > 0) return ensUrl.trim();
    // 2. Explicit env var override
    const fromEnv = process.env[agent.envVar];
    if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim();
    // 3. Default: orchestrator base + route
    return `${ORCHESTRATOR_BASE_URL}${agent.route}`;
  });
}

/** Resolve an agent descriptor from any name the orchestrator might emit. */
export function resolveAgent(name?: string): SwarmAgentDescriptor | undefined {
  if (!name) return undefined;
  if (SWARM_AGENTS_BY_CARD_NAME[name]) return SWARM_AGENTS_BY_CARD_NAME[name];
  const lower = name.toLowerCase();
  return SWARM_AGENTS.find(
    (a) => a.id === lower || a.cardName.toLowerCase() === lower,
  );
}
