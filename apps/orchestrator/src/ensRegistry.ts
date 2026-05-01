/**
 * ENS Agent Registry
 *
 * Resolves all Uniswap Swarm agent endpoints from on-chain ENS records.
 * Each agent has a subname under uniswapswarm.eth (e.g. researcher.uniswapswarm.eth)
 * with text records:
 *   - "url"  → A2A endpoint URL (e.g. https://uniswapswarm.railway.app/a2a/agents/researcher)
 *   - "name" → human-readable display name (e.g. "Researcher Agent")
 *
 * This makes ENS the single source of truth for agent discovery:
 * any caller that knows the ENS name can find the live endpoint without
 * any other configuration.
 *
 * At startup the orchestrator can also *write* its own public URL back to ENS
 * so that deployments self-register — update A2A_PUBLIC_BASE_URL and restart.
 */

import { ethers } from "ethers";
import { AGENT_ENS_NAMES, ENS_CONTRACTS_BY_CHAIN, logger } from "@swarm/shared";
import type { SwarmA2AAgentId } from "./a2aAgents";

// ── ABIs ──────────────────────────────────────────────────────────────────────

const REGISTRY_ABI = ["function resolver(bytes32 node) view returns (address)"];

const RESOLVER_ABI = [
  "function addr(bytes32 node) view returns (address)",
  "function text(bytes32 node, string key) view returns (string)",
  "function setText(bytes32 node, string key, string value)",
];

// ── Types ─────────────────────────────────────────────────────────────────────

export type AgentEnsRecord = {
  agentId: SwarmA2AAgentId;
  ensName: string;
  displayName: string | null;
  addr: string | null;
  /** Live A2A endpoint resolved from ENS text[url]. */
  url: string | null;
  /** Derived from url: the agent card JSON URL. */
  cardUrl: string | null;
};

// ── Internal helpers ──────────────────────────────────────────────────────────

function getProvider(): ethers.JsonRpcProvider | null {
  const rpcUrl = process.env.ENS_RPC_URL?.trim();
  if (!rpcUrl) return null;
  return new ethers.JsonRpcProvider(rpcUrl, 11155111, { staticNetwork: true });
}

const ENS_CHAIN = 11155111 as const;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Resolve all agent ENS records from Sepolia.
 * Results are cached for the lifetime of the process; pass forceRefresh=true
 * after publishing new records.
 */
let _cache: AgentEnsRecord[] | null = null;

export async function resolveAgentRegistry(
  forceRefresh = false,
): Promise<AgentEnsRecord[]> {
  if (_cache && !forceRefresh) return _cache;

  const provider = getProvider();
  if (!provider) {
    logger.warn("[ENS] ENS_RPC_URL not set — ENS agent discovery disabled");
    return [];
  }

  const { registry: registryAddr } = ENS_CONTRACTS_BY_CHAIN[ENS_CHAIN];
  const registry = new ethers.Contract(registryAddr, REGISTRY_ABI, provider);

  const results: AgentEnsRecord[] = [];

  for (const [agentId, ensName] of Object.entries(AGENT_ENS_NAMES) as [
    SwarmA2AAgentId,
    string,
  ][]) {
    const node = ethers.namehash(ensName);
    try {
      const resolverAddr: string = await registry.getFunction("resolver")(node);
      if (!resolverAddr || resolverAddr === ethers.ZeroAddress) {
        logger.warn(`[ENS] ${ensName}: no resolver — skipping`);
        results.push({
          agentId,
          ensName,
          displayName: null,
          addr: null,
          url: null,
          cardUrl: null,
        });
        continue;
      }

      const resolver = new ethers.Contract(
        resolverAddr,
        RESOLVER_ABI,
        provider,
      );
      const [addr, displayName, url] = await Promise.all([
        resolver
          .getFunction("addr")(node)
          .catch(() => null) as Promise<string | null>,
        resolver
          .getFunction("text")(node, "name")
          .catch(() => null) as Promise<string | null>,
        resolver
          .getFunction("text")(node, "url")
          .catch(() => null) as Promise<string | null>,
      ]);

      const cardUrl = url ? `${url}/.well-known/agent.json` : null;

      results.push({
        agentId,
        ensName,
        displayName: displayName || null,
        addr: addr || null,
        url: url || null,
        cardUrl,
      });

      logger.info(
        `[ENS] ${ensName} → ${url ?? "(no url set)"}${addr ? ` (addr: ${addr})` : ""}`,
      );
    } catch (err) {
      logger.warn(`[ENS] Failed to resolve ${ensName}: ${String(err)}`);
      results.push({
        agentId,
        ensName,
        displayName: null,
        addr: null,
        url: null,
        cardUrl: null,
      });
    }
  }

  _cache = results;
  return results;
}

/**
 * Write the orchestrator's public base URL back to ENS for all agents.
 * Called at startup when A2A_PUBLIC_BASE_URL is set and ENS keys are available.
 * This is idempotent — records already matching the target value are skipped.
 */
export async function publishAgentUrlsToEns(baseUrl: string): Promise<void> {
  const rpcUrl = process.env.ENS_RPC_URL?.trim();
  const rawKey = (
    process.env.ENS_RECORDS_PRIVATE_KEY ?? process.env.ENS_OWNER_PRIVATE_KEY
  )?.trim();

  if (!rpcUrl || !rawKey) {
    logger.info(
      "[ENS] Skipping ENS self-registration (ENS_RPC_URL or key not set)",
    );
    return;
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl, ENS_CHAIN, {
    staticNetwork: true,
  });
  const signer = new ethers.Wallet(rawKey, provider);
  const { registry: registryAddr } = ENS_CONTRACTS_BY_CHAIN[ENS_CHAIN];
  const registry = new ethers.Contract(registryAddr, REGISTRY_ABI, provider);

  logger.info(`[ENS] Self-registering agent URLs → base: ${baseUrl}`);

  for (const [agentId, ensName] of Object.entries(AGENT_ENS_NAMES) as [
    SwarmA2AAgentId,
    string,
  ][]) {
    const targetUrl = `${baseUrl}/a2a/agents/${agentId}`;
    const node = ethers.namehash(ensName);

    try {
      const resolverAddr: string = await registry.getFunction("resolver")(node);
      if (!resolverAddr || resolverAddr === ethers.ZeroAddress) {
        logger.warn(`[ENS] ${ensName}: no resolver — cannot publish url`);
        continue;
      }

      const resolver = new ethers.Contract(resolverAddr, RESOLVER_ABI, signer);
      const current: string = await resolver
        .getFunction("text")(node, "url")
        .catch(() => "");

      if (current === targetUrl) {
        logger.info(`[ENS] ${ensName}: url already current — skipped`);
        continue;
      }

      const tx: ethers.ContractTransactionResponse = await resolver.getFunction(
        "setText",
      )(node, "url", targetUrl);
      logger.info(
        `[ENS] ${ensName}: updating url → ${targetUrl} (tx ${tx.hash})`,
      );
      await tx.wait();
      logger.info(`[ENS] ${ensName}: url confirmed on-chain`);
    } catch (err) {
      logger.warn(`[ENS] ${ensName}: failed to publish url: ${String(err)}`);
    }
  }

  // Invalidate the cache so the next resolveAgentRegistry call reads fresh data
  _cache = null;
}
