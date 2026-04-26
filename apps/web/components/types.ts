/**
 * Shared types for the Uniswap Swarm chat UI.
 *
 * Mirrors the structure used by CopilotKit/a2a-travel but adapted for the
 * 6-agent Uniswap pipeline (Researcher / Planner / Risk / Strategy /
 * Critic / Executor).
 */

import type { ActionRenderProps } from "@copilotkit/react-core";

// ── Action render props ─────────────────────────────────────────────────────

export type MessageActionRenderProps = ActionRenderProps<
  [
    {
      readonly name: "agentName";
      readonly type: "string";
      readonly description: "The name of the A2A agent to send the message to";
    },
    {
      readonly name: "task";
      readonly type: "string";
      readonly description: "The message to send to the A2A agent";
    },
  ]
>;

// ── Agent payloads (whatever the SwarmAgentExecutor wraps) ──────────────────

export type ResearchCandidate = {
  symbol?: string;
  name?: string;
  address?: string;
  chain?: string;
  liquidityUsd?: number;
  score?: number;
  rationale?: string;
  [key: string]: unknown;
};

export type ResearchData = {
  candidates?: ResearchCandidate[];
  marketSummary?: string;
  dataSource?: string;
};

/**
 * Mirrors `AgentTask` in `@swarm/shared`:
 *   { agentId: string; action: string; input?: Record<string, unknown> }
 *
 * The legacy fields (`id`, `agent`, `description`) are kept as optional
 * fallbacks so older payloads still render gracefully, but new payloads are
 * expected to use `agentId` and `action`.
 */
export type PlanTask = {
  agentId?: string;
  action?: string;
  input?: Record<string, unknown>;
  // Legacy / alternate naming (kept for backwards compatibility):
  id?: string;
  agent?: string;
  description?: string;
  [key: string]: unknown;
};

export type PlanData = {
  strategy?: string;
  tasks?: PlanTask[];
  constraints?: Record<string, unknown>;
};

/**
 * Mirrors `RiskAssessment` in `@swarm/shared`:
 *   { tokenAddress, symbol, score, passed, flags: RiskFlag[], recommendation }
 *
 * Legacy short-form fields (`candidate`, `riskScore`, `reason`) are kept as
 * optional fallbacks so older payloads still render. `flags` accepts both the
 * canonical structured shape and the legacy `string[]` for the same reason.
 */
export type RiskFlagSeverity = "low" | "medium" | "high" | "critical";

export type RiskFlag = {
  type?: string;
  severity?: RiskFlagSeverity;
  detail?: string;
};

export type RiskAssessment = {
  tokenAddress?: string;
  symbol?: string;
  score?: number;
  passed?: boolean;
  flags?: RiskFlag[] | string[];
  recommendation?: string;
  checkedAt?: number;
  // Legacy / alternate naming (kept for backwards compatibility):
  candidate?: string;
  riskScore?: number;
  reason?: string;
};

export type RiskData = RiskAssessment[];

export type StrategyData = {
  tokenInSymbol?: string;
  tokenOutSymbol?: string;
  amountInUsd?: number;
  amountIn?: string;
  slippagePct?: number;
  feeTier?: number;
  chain?: string;
  rationale?: string;
};

export type CritiqueData = {
  approved?: boolean;
  confidence?: number;
  issues?: string[];
  notes?: string;
};

export type ExecutionData = {
  success?: boolean;
  dryRun?: boolean;
  txHash?: string | null;
  rationale?: string;
  pair?: string;
};

// ── 0G Storage audit trail (one row per agent write) ────────────────────────

export type AgentStorageWrite = {
  key: string;
  agentId: string;
  role: string;
  hash: string;
  ts: number;
  sizeBytes: number;
};

// ── Wrapped envelope returned by every swarm A2A agent ──────────────────────

type EnvelopeBase = {
  /** 0G Storage writes the agent performed during this run. */
  storage?: AgentStorageWrite[];
  /** Surfaced runtime error if the agent threw. */
  error?: string;
};

export type SwarmAgentEnvelope =
  | ({ agentId: "researcher"; data: ResearchData } & EnvelopeBase)
  | ({ agentId: "planner"; data: PlanData } & EnvelopeBase)
  | ({ agentId: "risk"; data: RiskData } & EnvelopeBase)
  | ({ agentId: "strategy"; data: StrategyData } & EnvelopeBase)
  | ({ agentId: "critic"; data: CritiqueData } & EnvelopeBase)
  | ({ agentId: "executor"; data: ExecutionData } & EnvelopeBase);

// ── HITL action render props ────────────────────────────────────────────────

export type SwapIntentActionRenderProps = ActionRenderProps<
  [
    {
      readonly name: "goal";
      readonly type: "string";
      readonly description: "Natural language description of the swap goal";
    },
    {
      readonly name: "tokenIn";
      readonly type: "string";
      readonly description: "Token symbol to sell";
    },
    {
      readonly name: "tokenOut";
      readonly type: "string";
      readonly description: "Token symbol to buy";
    },
    {
      readonly name: "amountUsd";
      readonly type: "number";
      readonly description: "Approximate USD size of the trade";
    },
    {
      readonly name: "riskLevel";
      readonly type: "string";
      readonly description: "Conservative, Balanced, or Aggressive";
    },
  ]
>;

export type TradeApprovalActionRenderProps = ActionRenderProps<
  [
    {
      readonly name: "strategy";
      readonly type: "string";
      readonly description: "JSON string of the proposed strategy/swap data to approve";
    },
    {
      readonly name: "critique";
      readonly type: "string";
      readonly description: "JSON string of the critic's verdict and confidence";
    },
  ]
>;

// ── Shared aggregated state for sidebar cards ───────────────────────────────

export type SwarmAggregateState = {
  research?: ResearchData;
  plan?: PlanData;
  risk?: RiskData;
  strategy?: StrategyData;
  critique?: CritiqueData;
  execution?: ExecutionData;
  request?: string;
  /** Append-only 0G Storage audit trail aggregated from every agent run. */
  storage?: AgentStorageWrite[];
};
