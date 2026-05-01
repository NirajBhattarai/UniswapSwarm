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
import { LedgerLowError } from "@swarm/compute";
import type { SwarmOrchestrator } from "./orchestrator";
import {
  getManagedPrivateKey,
  isManagedWalletFunded,
} from "./managedWallets";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { ZERO_ADDRESS } from "@swarm/shared";

/**
 * Each Uniswap Swarm agent is exposed as an A2A endpoint on the same port
 * with different routes:
 *
 *   researcher  -> /a2a/agents/researcher
 *   planner     -> /a2a/agents/planner
 *   risk        -> /a2a/agents/risk
 *   strategy    -> /a2a/agents/strategy
 *   critic      -> /a2a/agents/critic
 *   executor    -> /a2a/agents/executor
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

export type AgentDescriptor = {
  id: SwarmA2AAgentId;
  /** Human-friendly card name. Must match what the orchestrator LLM is told. */
  cardName: string;
  description: string;
  url?: string; // Will be set dynamically when routes are registered
  skillId: string;
  skillName: string;
  skillExamples: string[];
};

export const SWARM_AGENT_DESCRIPTORS: AgentDescriptor[] = [
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
];

export function getSwarmAgentDescriptors(): AgentDescriptor[] {
  return SWARM_AGENT_DESCRIPTORS;
}

// ── DynamoDB helper (managed wallet address lookup) ──────────────────────────

let _dynamo: DynamoDBDocumentClient | null | undefined;

function getDynamoClient(): DynamoDBDocumentClient | null {
  if (_dynamo !== undefined) return _dynamo;
  const region = process.env.DYNAMODB_REGION?.trim();
  const table = process.env.DYNAMODB_WALLETS_TABLE?.trim();
  if (!region || !table) {
    _dynamo = null;
    return null;
  }
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY?.trim();
  const sessionToken = process.env.AWS_SESSION_TOKEN?.trim() || undefined;
  const raw = new DynamoDBClient(
    accessKeyId && secretAccessKey
      ? {
          region,
          credentials: {
            accessKeyId,
            secretAccessKey,
            ...(sessionToken ? { sessionToken } : {}),
          },
        }
      : { region },
  );
  _dynamo = DynamoDBDocumentClient.from(raw, {
    marshallOptions: { removeUndefinedValues: true },
  });
  return _dynamo;
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

export type AgentExecutionHookParams = {
  agentId: SwarmA2AAgentId;
  sessionId: string;
  payload: unknown;
  walletAddress?: string;
  runError?: string;
};

class SwarmAgentExecutor implements AgentExecutor {
  constructor(
    private readonly orchestrator: SwarmOrchestrator,
    private readonly agent: AgentDescriptor,
    private readonly onAgentExecuted?: (
      params: AgentExecutionHookParams,
    ) => Promise<void> | void,
  ) {}

  async execute(
    requestContext: RequestContext,
    eventBus: ExecutionEventBus,
  ): Promise<void> {
    const userText = extractUserText(requestContext);
    const walletAddress = extractWalletAddress(userText);
    // Use a simple hash of the first few chars of the contextId to create
    // a semi-stable session that will likely be the same for related calls
    // in a short time window. This is a heuristic approach.
    const sessionId = extractStableSessionId(requestContext);

    logger.info(
      `[A2A] ${this.agent.cardName} called with sessionId=${sessionId}${walletAddress ? ` wallet=${walletAddress}` : ""} (contextId=${requestContext.contextId})`,
    );

    // Capture timestamp BEFORE running so we can identify any memory entries
    // this agent wrote to 0G Storage during this run.
    const sinceTs = Date.now();
    const beforeKeys = new Set(
      this.orchestrator.getMemory(sessionId).map((entry) => entry.key),
    );

    let payload: unknown;
    let runError: string | undefined;
    try {
      // If the user has a funded managed wallet, bind this session to use
      // their dedicated ZGCompute + ZGStorage (pays for 0G inference/storage
      // from the user's wallet rather than the shared operator key).
      if (walletAddress) {
        try {
          const managedKey = await getManagedPrivateKey(walletAddress);
          if (managedKey) {
            // Look up the managed address so we can check the balance
            const dynamo = getDynamoClient();
            let managedAddress: string | null = null;
            if (dynamo) {
              const item = await dynamo
                .send(
                  new GetCommand({
                    TableName:
                      process.env.DYNAMODB_WALLETS_TABLE?.trim() ?? "",
                    Key: { connectedAddress: walletAddress.toLowerCase() },
                  }),
                )
                .then((r) => r.Item ?? null)
                .catch(() => null);
              managedAddress =
                (item as { managedAddress?: string } | null)?.managedAddress ??
                null;
            }
            const funded =
              managedAddress !== null
                ? await isManagedWalletFunded(managedAddress)
                : false;
            if (funded) {
              await this.orchestrator.ensureManagedSession(
                sessionId,
                walletAddress,
                managedKey,
              );
            }
          }
        } catch (managedErr) {
          if (managedErr instanceof LedgerLowError) {
            // Surface ledger-low as a top-level error so the frontend shows the
            // deposit prompt instead of silently running without a managed wallet.
            throw new Error(
              `Your 0G Compute ledger balance (${managedErr.ledgerBalance.toFixed(4)} OG) is below the ` +
                `minimum required (${managedErr.minRequired} OG). Please send more A0GI to your ` +
                `managed wallet to top up the ledger, then try again.`,
            );
          }
          logger.warn(
            `[A2A] Managed wallet setup skipped for ${walletAddress}: ${
              managedErr instanceof Error
                ? managedErr.message
                : String(managedErr)
            }`,
          );
        }
      }
      payload = await this.runAgent(userText, sessionId, walletAddress);
    } catch (err) {
      runError = err instanceof Error ? err.message : String(err);
      payload = { error: `Agent ${this.agent.id} failed: ${runError}` };
      logger.error(`[A2A] ${this.agent.cardName} error: ${runError}`);
    }

    const writes = this.collectAgentWrites(sessionId, sinceTs, beforeKeys);
    if (this.onAgentExecuted) {
      const hookParams: AgentExecutionHookParams = {
        agentId: this.agent.id,
        sessionId,
        payload,
      };
      if (walletAddress) hookParams.walletAddress = walletAddress;
      if (runError) hookParams.runError = runError;
      await this.onAgentExecuted(hookParams);
    }

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
    sessionId: string,
    sinceTs: number,
    beforeKeys: Set<string>,
  ): AgentStorageWrite[] {
    const prefix = `${this.agent.id}/`;
    return this.orchestrator
      .getMemory(sessionId)
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

  private async runAgent(
    goal: string,
    sessionId: string,
    walletAddress?: string,
  ): Promise<unknown> {
    switch (this.agent.id) {
      case "researcher":
        return this.orchestrator.runResearcher(
          sessionId,
          goal,
          undefined,
          walletAddress,
        );
      case "planner":
        return this.orchestrator.runPlanner(sessionId, goal);
      case "risk":
        return this.orchestrator.runRisk(sessionId);
      case "strategy":
        return this.orchestrator.runStrategy(
          sessionId,
          undefined,
          walletAddress,
        );
      case "critic":
        return this.orchestrator.runCritic(sessionId);
      case "executor":
        return this.orchestrator.runExecutor(sessionId);
    }
  }
}

function extractWalletAddress(text: string): string | undefined {
  // Only accept addresses explicitly tagged as wallet identity, never any
  // arbitrary token/pool address that might appear in agent task text.
  const labeledMatch =
    text.match(/wallet(?:\s+address)?\s*[:=]\s*(0x[a-fA-F0-9]{40})/i) ??
    text.match(/"walletAddress"\s*:\s*"(0x[a-fA-F0-9]{40})"/i);
  const normalized = labeledMatch?.[1]?.toLowerCase();
  if (!normalized || normalized === ZERO_ADDRESS) return undefined;
  return normalized;
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

/**
 * Extract a stable session ID. Since each A2A agent call gets a unique contextId
 * and we can't easily pass custom headers through the A2A middleware, we use
 * a simple heuristic: use "shared-session" for all agents to force memory sharing.
 *
 * This means all conversations share the same memory, which is fine for development
 * but should be improved for production (e.g., by adding session management in the orchestrator).
 */
function extractStableSessionId(requestContext: RequestContext): string {
  // For now, use a single shared session for all agents
  // TODO: Implement proper session management based on user/conversation context
  return "shared-session";
}

// ── Agent server bootstrap ───────────────────────────────────────────────────

export type StartedAgentServer = {
  agent: AgentDescriptor;
  route: string;
  url: string;
  cardUrl: string;
};

/**
 * Register all Swarm A2A agent handlers on the same express app with different routes.
 * Instead of separate ports (4101-4106), all agents are on the main port with routes like:
 *   /a2a/agents/researcher
 *   /a2a/agents/planner
 *   /a2a/agents/risk
 *   etc.
 */
export function registerSwarmA2AAgentRoutes(
  app: express.Application,
  orchestrator: SwarmOrchestrator,
  baseUrl: string,
  onAgentExecuted?: (params: AgentExecutionHookParams) => Promise<void> | void,
): StartedAgentServer[] {
  const started: StartedAgentServer[] = [];

  for (const descriptor of SWARM_AGENT_DESCRIPTORS) {
    const route = `/a2a/agents/${descriptor.id}`;
    const agentUrl = `${baseUrl}${route}`;

    // Update descriptor URL to use the route-based URL
    const updatedDescriptor = { ...descriptor, url: agentUrl };
    const card: AgentCard = buildAgentCard(updatedDescriptor);

    const requestHandler = new DefaultRequestHandler(
      card,
      new InMemoryTaskStore(),
      new SwarmAgentExecutor(orchestrator, updatedDescriptor, onAgentExecuted),
    );

    // Serve the agent card at both the new (>=0.3.x) and legacy (<=0.2.x)
    // well-known paths so we're compatible with whatever @a2a-js/sdk version
    // the consuming client (e.g. @ag-ui/a2a-middleware) was built against.
    const cardHandler = agentCardHandler({ agentCardProvider: requestHandler });
    const cardPaths = [
      `${route}/${AGENT_CARD_PATH}`,
      `${route}/.well-known/agent.json`,
      `${route}/.well-known/agent-card.json`,
    ];

    for (const path of cardPaths) {
      app.use(path, cardHandler);
    }

    app.use(
      route,
      jsonRpcHandler({
        requestHandler,
        userBuilder: UserBuilder.noAuthentication,
      }),
    );

    logger.info(
      `[A2A] ${descriptor.cardName} registered at ${agentUrl} (cards: ${cardPaths.join(", ")})`,
    );

    started.push({
      agent: descriptor,
      route,
      url: agentUrl,
      cardUrl: `${agentUrl}/${AGENT_CARD_PATH}`,
    });
  }

  return started;
}

function buildAgentCard(
  descriptor: AgentDescriptor & { url: string },
): AgentCard {
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
