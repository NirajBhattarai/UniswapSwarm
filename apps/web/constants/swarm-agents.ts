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
