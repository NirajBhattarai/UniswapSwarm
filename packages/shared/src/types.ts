// ─── Agent output types ───────────────────────────────────────────────────────

export interface TradeConstraints {
  maxSlippagePct: number; // e.g. 1.5
  maxPositionUSDC: number; // e.g. 100
  minLiquidityUSD: number; // e.g. 50_000
  maxGasGwei: number; // e.g. 30
  allowUnverified: boolean;
}

export interface AgentTask {
  agentId: string;
  action: string;
  input?: Record<string, unknown>;
}

export interface TradePlan {
  goal: string;
  strategy: "arbitrage" | "momentum" | "lp_rotation" | "custom";
  constraints: TradeConstraints;
  tasks: AgentTask[];
  rationale: string;
  createdAt: number;
}

// ─── Research types ────────────────────────────────────────────────────────────

export interface TokenCandidate {
  address: string; // checksummed ERC-20 address
  symbol: string;
  name: string;
  pairAddress: string; // Uniswap V3 pool address
  baseToken: string; // WETH | USDC | USDT
  priceUSD: number;
  liquidityUSD: number;
  volume24hUSD: number;
  priceChange24hPct: number;
  poolFeeTier: number; // 500 | 3000 | 10000
  txCount: number;
}

export interface ResearchReport {
  timestamp: number;
  marketSummary: string;
  candidates: TokenCandidate[];
  dataSource: string;
}

// ─── Risk types ────────────────────────────────────────────────────────────────

export type RiskFlagType =
  | "honeypot"
  | "low_liquidity"
  | "high_tax"
  | "unverified_contract"
  | "proxy_pattern"
  | "mev_risk"
  | "rug_pull_risk"
  | "concentrated_ownership";

export type RiskSeverity = "low" | "medium" | "high" | "critical";

export interface RiskFlag {
  type: RiskFlagType;
  severity: RiskSeverity;
  detail: string;
}

export interface RiskAssessment {
  tokenAddress: string;
  symbol: string;
  score: number; // 0-100 (higher = safer)
  passed: boolean; // true if score >= threshold and no critical flags
  flags: RiskFlag[];
  recommendation: string;
  checkedAt: number;
}

// ─── Strategy types ────────────────────────────────────────────────────────────

export interface TradeStrategy {
  type: "buy" | "sell" | "swap";
  tokenIn: string;
  tokenOut: string;
  tokenInSymbol: string;
  tokenOutSymbol: string;
  amountInWei: string;
  minAmountOutWei: string;
  slippagePct: number;
  poolFee: number;
  expectedOutputUSD: number;
  estimatedGasUSD: number;
  rationale: string;
}

// ─── Critique types ────────────────────────────────────────────────────────────

export interface Critique {
  approved: boolean;
  confidence: number; // 0-100
  issues: string[];
  suggestions: string[];
  summary: string;
}

// ─── Execution types ───────────────────────────────────────────────────────────

export interface ExecutionResult {
  dryRun: boolean; // true = simulated only
  txHash: string | null;
  success: boolean;
  amountIn: string;
  amountOut: string | null;
  gasUsed: string | null;
  priceImpactPct: number | null;
  executedAt: number;
  error?: string;
}

// ─── Full cycle state ──────────────────────────────────────────────────────────

export interface SwarmCycleState {
  cycleId: string;
  startedAt: number;
  completedAt?: number;
  plan?: TradePlan;
  research?: ResearchReport;
  riskAssessments?: RiskAssessment[];
  strategy?: TradeStrategy;
  critique?: Critique;
  execution?: ExecutionResult;
}

// ─── Memory entry (blackboard) ─────────────────────────────────────────────────

export interface MemoryEntry {
  key: string;
  agentId: string;
  role: string;
  value: unknown;
  hash: string; // 0G Storage hash (or local fallback)
  ts: number;
}

// ─── Swarm event (SSE) ─────────────────────────────────────────────────────────

export type SwarmEventType =
  | "cycle_start"
  | "agent_start"
  | "agent_done"
  | "delta" // LLM token stream
  | "cycle_done"
  | "cycle_error";

export interface SwarmEvent {
  type: SwarmEventType;
  cycleId: string;
  agentId: string;
  content?: string; // delta text or JSON summary
  data?: unknown; // structured payload (for done events)
  ts: number;
}
