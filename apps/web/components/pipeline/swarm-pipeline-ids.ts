import { SWARM_AGENTS } from "../../lib/swarm-agents";

/**
 * Stable DOM / React Flow node ids for the A2A pipeline (must match anchors in SwarmDataCards).
 */
export const SWARM_PIPELINE_NODE_IDS = {
  userIntent: "user-intent",
  researcher: "researcher",
  planner: "planner",
  risk: "risk",
  strategy: "strategy",
  critic: "critic",
  executor: "executor",
  storage: "storage",
} as const;

export type SwarmPipelineNodeId =
  (typeof SWARM_PIPELINE_NODE_IDS)[keyof typeof SWARM_PIPELINE_NODE_IDS];

/** Top-to-bottom pipeline order (User intent → agents). */
export const SWARM_PIPELINE_STAGE_ORDER: readonly string[] = [
  SWARM_PIPELINE_NODE_IDS.userIntent,
  ...SWARM_AGENTS.map((a) => a.id),
];
