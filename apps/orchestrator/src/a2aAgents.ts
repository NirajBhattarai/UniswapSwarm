import express from "express";
import {
  AGENT_CARD_PATH,
  type AgentCard,
  type Message,
  type TextPart,
} from "@a2a-js/sdk";
import {
  DefaultRequestHandler,
  InMemoryTaskStore,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
} from "@a2a-js/sdk/server";
import {
  UserBuilder,
  agentCardHandler,
  jsonRpcHandler,
} from "@a2a-js/sdk/server/express";
import { v4 as uuidv4 } from "uuid";
import { logger } from "@swarm/shared";
import type { SwarmOrchestrator } from "./orchestrator";

/**
 * Each Uniswap Swarm agent is exposed as its own standalone A2A server, just
 * like the LangGraph + ADK agents in CopilotKit/a2a-travel.
 *
 *   researcher  -> :4101
 *   planner     -> :4102
 *   risk        -> :4103
 *   strategy    -> :4104
 *   critic      -> :4105
 *   executor    -> :4106
 *
 * The CopilotKit web app's A2AMiddlewareAgent will register all these URLs
 * and the orchestrator LLM will route via the auto-injected
 * `send_message_to_a2a_agent` tool.
 */

export type SwarmA2AAgentId =
  | "researcher"
  | "planner"
  | "risk"
  | "strategy"
  | "critic"
  | "executor";

const HTTP_HOST = process.env.A2A_HOST ?? "0.0.0.0";

const PORTS: Record<SwarmA2AAgentId, number> = {
  researcher: Number(process.env.RESEARCHER_PORT ?? 4101),
  planner: Number(process.env.PLANNER_PORT ?? 4102),
  risk: Number(process.env.RISK_PORT ?? 4103),
  strategy: Number(process.env.STRATEGY_PORT ?? 4104),
  critic: Number(process.env.CRITIC_PORT ?? 4105),
  executor: Number(process.env.EXECUTOR_PORT ?? 4106),
};

const PUBLIC_HOST = process.env.A2A_PUBLIC_HOST ?? `http://localhost`;

export type AgentDescriptor = {
  id: SwarmA2AAgentId;
  /** Human-friendly card name. Must match what the orchestrator LLM is told. */
  cardName: string;
  description: string;
  port: number;
  url: string;
  skillId: string;
  skillName: string;
  skillExamples: string[];
};

export const SWARM_AGENT_DESCRIPTORS: AgentDescriptor[] = (
  [
    {
      id: "researcher",
      cardName: "Researcher Agent",
      description:
        "Researches Uniswap V2/V3/V4 + UniswapX pools and returns ranked candidate trade tokens with live market data, narratives, and risk hints.",
      skillId: "researcher",
      skillName: "Token Researcher",
      skillExamples: [
        "Find safe trade candidates around ETH UNI ARB",
        "Scan Uniswap pools for low-risk swap ideas",
      ],
    },
    {
      id: "planner",
      cardName: "Planner Agent",
      description:
        "Builds a structured TradePlan (strategy, constraints, task graph) from the research candidates.",
      skillId: "planner",
      skillName: "Trade Planner",
      skillExamples: [
        "Plan a conservative swap based on the research report",
        "Create a multi-step trade plan for ETH/USDC",
      ],
    },
    {
      id: "risk",
      cardName: "Risk Agent",
      description:
        "Evaluates each candidate token for honeypots, ownership concentration, MEV exposure, liquidity, and outputs RiskAssessments.",
      skillId: "risk",
      skillName: "Risk Assessor",
      skillExamples: [
        "Score risk for the candidate tokens",
        "Flag any unsafe tokens in the plan",
      ],
    },
    {
      id: "strategy",
      cardName: "Strategy Agent",
      description:
        "Selects the highest-scoring safe candidate, sizes the position, picks the route, and emits an exact swap calldata spec (TradeStrategy).",
      skillId: "strategy",
      skillName: "Trade Strategy",
      skillExamples: [
        "Build the best concrete swap from approved tokens",
        "Pick token-in/token-out, size and slippage",
      ],
    },
    {
      id: "critic",
      cardName: "Critic Agent",
      description:
        "Reviews the assembled plan + strategy and approves/rejects with confidence + issues list.",
      skillId: "critic",
      skillName: "Trade Critic",
      skillExamples: [
        "Approve or reject the proposed trade",
        "Audit the plan for issues",
      ],
    },
    {
      id: "executor",
      cardName: "Executor Agent",
      description:
        "Executes (or simulates, when DRY_RUN=true) the approved swap via Uniswap SwapRouter02.",
      skillId: "executor",
      skillName: "Trade Executor",
      skillExamples: [
        "Execute the approved swap (dry-run by default)",
        "Submit the trade and report tx hash",
      ],
    },
  ] satisfies Omit<AgentDescriptor, "port" | "url">[]
).map((entry) => ({
  ...entry,
  skillExamples: [...entry.skillExamples],
  port: PORTS[entry.id],
  url: `${PUBLIC_HOST}:${PORTS[entry.id]}`,
}));

export function getSwarmAgentDescriptors(): AgentDescriptor[] {
  return SWARM_AGENT_DESCRIPTORS;
}

// ── Executors ────────────────────────────────────────────────────────────────

/**
 * Per-agent 0G Storage write surfaced to the frontend so the user can see
 * what each agent wrote to the audit trail (key, root hash, size, timestamp).
 */
export type AgentStorageWrite = {
  key: string;
  agentId: string;
  role: string;
  hash: string;
  ts: number;
  sizeBytes: number;
};

class SwarmAgentExecutor implements AgentExecutor {
  constructor(
    private readonly orchestrator: SwarmOrchestrator,
    private readonly agent: AgentDescriptor,
  ) {}

  async execute(
    requestContext: RequestContext,
    eventBus: ExecutionEventBus,
  ): Promise<void> {
    const userText = extractUserText(requestContext);
    // Capture timestamp BEFORE running so we can identify any memory entries
    // this agent wrote to 0G Storage during this run.
    const sinceTs = Date.now();
    const beforeKeys = new Set(
      this.orchestrator.getMemory().map((entry) => entry.key),
    );

    let payload: unknown;
    let runError: string | undefined;
    try {
      payload = await this.runAgent(userText);
    } catch (err) {
      runError = err instanceof Error ? err.message : String(err);
      payload = { error: `Agent ${this.agent.id} failed: ${runError}` };
    }

    const writes = this.collectAgentWrites(sinceTs, beforeKeys);

    const response: Message = {
      kind: "message",
      messageId: uuidv4(),
      role: "agent",
      contextId: requestContext.contextId,
      parts: [
        {
          kind: "text",
          text: serialiseAgentPayload(this.agent.id, payload, writes, runError),
        } satisfies TextPart,
      ],
    };

    eventBus.publish(response);
    eventBus.finished();
  }

  /**
   * Find memory entries this agent wrote during the current run.
   * Memory keys follow `<agentId>/<slot>` (researcher/report, planner/plan,
   * risk/assessments, …) so we filter by prefix. We additionally include
   * any entry whose timestamp is newer than `sinceTs` and whose key wasn't
   * present before — guards against stale snapshots and handles the case
   * where another runner overwrites the same slot.
   */
  private collectAgentWrites(
    sinceTs: number,
    beforeKeys: Set<string>,
  ): AgentStorageWrite[] {
    const prefix = `${this.agent.id}/`;
    return this.orchestrator
      .getMemory()
      .filter((entry) => {
        if (!entry.key.startsWith(prefix)) return false;
        // Either the key is brand-new this run, or its timestamp is fresh
        // enough that we can confidently attribute it to this run.
        return !beforeKeys.has(entry.key) || entry.ts >= sinceTs;
      })
      .map((entry) => ({
        key: entry.key,
        agentId: entry.agentId,
        role: entry.role,
        hash: entry.hash,
        ts: entry.ts,
        sizeBytes: estimateJsonByteLength(entry.value),
      }));
  }

  cancelTask = async (): Promise<void> => {};

  private async runAgent(goal: string): Promise<unknown> {
    switch (this.agent.id) {
      case "researcher":
        return this.orchestrator.runResearcher(goal);
      case "planner":
        return this.orchestrator.runPlanner(goal);
      case "risk":
        return this.orchestrator.runRisk();
      case "strategy":
        return this.orchestrator.runStrategy();
      case "critic":
        return this.orchestrator.runCritic();
      case "executor":
        return this.orchestrator.runExecutor();
    }
  }
}

function serialiseAgentPayload(
  id: SwarmA2AAgentId,
  payload: unknown,
  storage: AgentStorageWrite[] = [],
  error?: string,
): string {
  // Include the agentId, raw data, the storage audit trail (0G writes) and
  // an optional error so the frontend can render the right structured-data
  // card AND surface the storage rootHash/key trail to the user.
  const wrapped: {
    agentId: SwarmA2AAgentId;
    data: unknown;
    storage: AgentStorageWrite[];
    error?: string;
  } = { agentId: id, data: payload, storage };
  if (error) wrapped.error = error;
  return JSON.stringify(wrapped, null, 2);
}

function estimateJsonByteLength(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "");
  } catch {
    return 0;
  }
}

function extractUserText(requestContext: RequestContext): string {
  const parts = requestContext.userMessage?.parts ?? [];
  const textPart = parts.find(
    (part): part is TextPart =>
      typeof part === "object" &&
      part !== null &&
      "kind" in part &&
      (part as { kind?: unknown }).kind === "text" &&
      "text" in part &&
      typeof (part as { text?: unknown }).text === "string",
  );
  return (
    textPart?.text?.trim() || "Run for the current shared blackboard state."
  );
}

// ── Agent server bootstrap ───────────────────────────────────────────────────

export type StartedAgentServer = {
  agent: AgentDescriptor;
  port: number;
  url: string;
  cardUrl: string;
};

export async function startSwarmA2AAgentServers(
  orchestrator: SwarmOrchestrator,
): Promise<StartedAgentServer[]> {
  const started: StartedAgentServer[] = [];

  for (const descriptor of SWARM_AGENT_DESCRIPTORS) {
    const card: AgentCard = buildAgentCard(descriptor);

    const requestHandler = new DefaultRequestHandler(
      card,
      new InMemoryTaskStore(),
      new SwarmAgentExecutor(orchestrator, descriptor),
    );

    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization",
      );
      if (req.method === "OPTIONS") {
        res.status(204).end();
        return;
      }
      next();
    });

    // Serve the agent card at both the new (>=0.3.x) and legacy (<=0.2.x)
    // well-known paths so we're compatible with whatever @a2a-js/sdk version
    // the consuming client (e.g. @ag-ui/a2a-middleware) was built against.
    const cardHandler = agentCardHandler({ agentCardProvider: requestHandler });
    const cardPaths = Array.from(
      new Set([
        `/${AGENT_CARD_PATH}`,
        "/.well-known/agent.json",
        "/.well-known/agent-card.json",
      ]),
    );
    for (const path of cardPaths) {
      app.use(path, cardHandler);
    }
    app.use(
      "/",
      jsonRpcHandler({
        requestHandler,
        userBuilder: UserBuilder.noAuthentication,
      }),
    );

    await new Promise<void>((resolve) => {
      app.listen(descriptor.port, HTTP_HOST, () => {
        logger.info(
          `[A2A] ${descriptor.cardName} listening on ${descriptor.url} (cards: ${cardPaths
            .map((p) => `${descriptor.url}${p}`)
            .join(", ")})`,
        );
        resolve();
      });
    });

    started.push({
      agent: descriptor,
      port: descriptor.port,
      url: descriptor.url,
      cardUrl: `${descriptor.url}/${AGENT_CARD_PATH}`,
    });
  }

  return started;
}

function buildAgentCard(descriptor: AgentDescriptor): AgentCard {
  return {
    name: descriptor.cardName,
    description: descriptor.description,
    protocolVersion: "0.3.0",
    version: "0.1.0",
    url: descriptor.url,
    skills: [
      {
        id: descriptor.skillId,
        name: descriptor.skillName,
        description: descriptor.description,
        tags: ["uniswap", "swarm", descriptor.id],
        examples: descriptor.skillExamples,
      },
    ],
    capabilities: { pushNotifications: false },
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
  };
}
