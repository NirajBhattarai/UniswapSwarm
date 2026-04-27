/**
 * Static descriptors for the Uniswap Swarm A2A agent fleet.
 *
 * Mirrors `apps/orchestrator/src/a2aAgents.ts`. Keep these arrays in sync.
 */

export type SwarmAgentId =
  | "researcher"
  | "planner"
  | "risk"
  | "strategy"
  | "critic"
  | "executor";

export type SwarmAgentDescriptor = {
  id: SwarmAgentId;
  /** Card name as published by the A2A server – used for routing by the orchestrator LLM. */
  cardName: string;
  description: string;
  route: string;
  envVar: string;
  emoji: string;
  badge: string;
};

// All agents now run on the same port (4000) with route-based endpoints
const ORCHESTRATOR_BASE_URL =
  process.env.ORCHESTRATOR_URL ?? "http://localhost:4000";

export const SWARM_AGENTS: SwarmAgentDescriptor[] = [
  {
    id: "researcher",
    cardName: "Researcher Agent",
    description:
      "Researches Uniswap V2/V3/V4 + UniswapX pools, fetches CoinGecko market data and narrative signals, and returns ranked candidate trade tokens.",
    route: "/a2a/agents/researcher",
    envVar: "RESEARCHER_AGENT_URL",
    emoji: "🔎",
    badge: "Researcher",
  },
  {
    id: "planner",
    cardName: "Planner Agent",
    description:
      "Builds a structured TradePlan with strategy, risk constraints, and per-agent task graph.",
    route: "/a2a/agents/planner",
    envVar: "PLANNER_AGENT_URL",
    emoji: "🗺️",
    badge: "Planner",
  },
  {
    id: "risk",
    cardName: "Risk Agent",
    description:
      "Scores honeypot, ownership concentration, MEV exposure, and liquidity risks, marking unsafe candidates.",
    route: "/a2a/agents/risk",
    envVar: "RISK_AGENT_URL",
    emoji: "🛡️",
    badge: "Risk",
  },
  {
    id: "strategy",
    cardName: "Strategy Agent",
    description:
      "Picks the safest highest-scoring candidate and crafts the exact swap calldata spec (token-in/out, fee, slippage).",
    route: "/a2a/agents/strategy",
    envVar: "STRATEGY_AGENT_URL",
    emoji: "🎯",
    badge: "Strategy",
  },
  {
    id: "critic",
    cardName: "Critic Agent",
    description:
      "Reviews the assembled plan + strategy and approves/rejects with confidence and issues list.",
    route: "/a2a/agents/critic",
    envVar: "CRITIC_AGENT_URL",
    emoji: "⚖️",
    badge: "Critic",
  },
  {
    id: "executor",
    cardName: "Executor Agent",
    description:
      "Executes (or simulates, when DRY_RUN=true) the approved swap via Uniswap SwapRouter02.",
    route: "/a2a/agents/executor",
    envVar: "EXECUTOR_AGENT_URL",
    emoji: "⚡",
    badge: "Executor",
  },
];

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

/** Resolve an agent descriptor from any name the orchestrator might emit. */
export function resolveAgent(name?: string): SwarmAgentDescriptor | undefined {
  if (!name) return undefined;
  if (SWARM_AGENTS_BY_CARD_NAME[name]) return SWARM_AGENTS_BY_CARD_NAME[name];
  const lower = name.toLowerCase();
  return SWARM_AGENTS.find(
    (a) => a.id === lower || a.cardName.toLowerCase() === lower,
  );
}
