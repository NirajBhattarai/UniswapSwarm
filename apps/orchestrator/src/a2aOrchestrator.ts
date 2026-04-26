import { v4 as uuidv4 } from "uuid";
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
  restHandler,
} from "@a2a-js/sdk/server/express";
import type express from "express";
import type { SwarmOrchestrator } from "./orchestrator";

export type SwarmFlowStep = {
  from: "user" | "orchestrator";
  to: string;
  action: string;
  status: "selected" | "running" | "completed";
  detail?: string;
};

export type SwarmTransfer = {
  from: string;
  to: string;
  summary: string;
  payload?: Record<string, unknown>;
};

class SwarmA2AExecutor implements AgentExecutor {
  constructor(private readonly orchestrator: SwarmOrchestrator) {}

  async execute(
    requestContext: RequestContext,
    eventBus: ExecutionEventBus,
  ): Promise<void> {
    const text = extractUserText(requestContext);
    const selectedAgent = selectAgentForIntent(text);

    const { result, flow, transfers } = await runSelectedAgent(
      this.orchestrator,
      selectedAgent,
      text,
    );
    const response: Message = {
      kind: "message",
      messageId: uuidv4(),
      role: "agent",
      contextId: requestContext.contextId,
      parts: [
        {
          kind: "text",
          text: JSON.stringify(
            {
              orchestrator: "google-a2a-style-gateway",
              request: text,
              selectedAgent,
              flow,
              transfers,
              result,
            },
            null,
            2,
          ),
        } satisfies TextPart,
      ],
    };

    eventBus.publish(response);
    eventBus.finished();
  }

  cancelTask = async (): Promise<void> => {};
}

export type SwarmAgentName =
  | "trade_pipeline"
  | "researcher"
  | "researcher_market"
  | "researcher_prices"
  | "planner"
  | "risk"
  | "strategy"
  | "critic"
  | "executor"
  | "cycle"
  | "wallet_watch";

export function selectAgentForIntent(text: string): SwarmAgentName {
  const q = text.toLowerCase();

  if (
    q.includes("best trade") ||
    q.includes("best token") ||
    q.includes("trade token") ||
    q.includes("find trade") ||
    q.includes("trading opportunity")
  ) {
    return "trade_pipeline";
  }

  if (
    q.includes("price") ||
    q.includes("quote") ||
    q.includes("token price") ||
    q.includes("how much")
  ) {
    return "researcher_prices";
  }
  if (
    q.includes("market") ||
    q.includes("trending") ||
    q.includes("narrative") ||
    q.includes("news")
  ) {
    return "researcher_market";
  }
  if (q.includes("wallet")) return "wallet_watch";
  if (q.includes("full cycle") || q.includes("run cycle")) return "cycle";
  if (q.includes("research")) return "researcher";
  if (q.includes("plan")) return "planner";
  if (q.includes("risk")) return "risk";
  if (q.includes("strategy")) return "strategy";
  if (q.includes("critic")) return "critic";
  if (q.includes("execute") || q.includes("swap")) return "executor";
  return "researcher";
}

async function runSelectedAgent(
  orchestrator: SwarmOrchestrator,
  selectedAgent: SwarmAgentName,
  text: string,
): Promise<{
  result: unknown;
  flow: SwarmFlowStep[];
  transfers: SwarmTransfer[];
}> {
  const flow: SwarmFlowStep[] = [
    {
      from: "user",
      to: "orchestrator",
      action: "submit_request",
      status: "completed",
      detail: text,
    },
    {
      from: "orchestrator",
      to: selectedAgent,
      action: "route_by_intent",
      status: "selected",
    },
  ];
  const transfers: SwarmTransfer[] = [];

  switch (selectedAgent) {
    case "trade_pipeline": {
      const result = await runTradePipeline(
        orchestrator,
        text,
        flow,
        transfers,
      );
      return { result, flow, transfers };
    }
    case "wallet_watch": {
      flow.push({
        from: "orchestrator",
        to: "researcher",
        action: "wallet_watch_research",
        status: "running",
      });
      const research = await orchestrator.runResearcher(text);

      flow.push({
        from: "orchestrator",
        to: "researcher",
        action: "wallet_watch_research",
        status: "completed",
      });
      transfers.push({
        from: "researcher",
        to: "planner",
        summary: "Research report handed to planner",
        payload: {
          candidates: research.candidates.length,
          marketSummary: research.marketSummary,
        },
      });
      flow.push({
        from: "orchestrator",
        to: "planner",
        action: "wallet_watch_plan",
        status: "running",
      });
      const plan = await orchestrator.runPlanner(text);

      flow.push({
        from: "orchestrator",
        to: "planner",
        action: "wallet_watch_plan",
        status: "completed",
      });
      transfers.push({
        from: "planner",
        to: "orchestrator",
        summary: "Planner returned wallet watch action plan",
        payload: {
          strategy: plan.strategy,
          tasks: plan.tasks.length,
        },
      });

      return { result: { research, plan, readyToSign: true }, flow, transfers };
    }
    case "cycle": {
      const result = await orchestrator.runCycle();
      flow.push({
        from: "orchestrator",
        to: "cycle",
        action: "execute_full_pipeline",
        status: "completed",
      });
      return { result, flow, transfers };
    }
    case "researcher_market": {
      const tokens = extractTokens(text);
      const result = await orchestrator.fetchMarketData(tokens);
      flow.push({
        from: "orchestrator",
        to: "researcher_market",
        action: "fetch_market_data",
        status: "completed",
        detail: `tokens=${tokens.join(",")}`,
      });
      transfers.push({
        from: "orchestrator",
        to: "chat",
        summary: "Market data transfer ready",
        payload: { tokens },
      });
      return { result, flow, transfers };
    }
    case "researcher_prices": {
      const tokens = extractTokens(text);
      const result = await orchestrator.fetchPrices(tokens);
      flow.push({
        from: "orchestrator",
        to: "researcher_prices",
        action: "fetch_token_prices",
        status: "completed",
        detail: `tokens=${tokens.join(",")}`,
      });
      transfers.push({
        from: "orchestrator",
        to: "chat",
        summary: "Token price transfer ready",
        payload: { tokens },
      });
      return { result, flow, transfers };
    }
    case "researcher": {
      const result = await orchestrator.runResearcher(text);
      flow.push({
        from: "orchestrator",
        to: "researcher",
        action: "run_researcher_report",
        status: "completed",
      });
      return { result, flow, transfers };
    }
    case "planner": {
      const result = await orchestrator.runPlanner(text);
      flow.push({
        from: "orchestrator",
        to: "planner",
        action: "run_plan",
        status: "completed",
      });
      return { result, flow, transfers };
    }
    case "risk": {
      const result = await orchestrator.runRisk();
      flow.push({
        from: "orchestrator",
        to: "risk",
        action: "run_risk",
        status: "completed",
      });
      return { result, flow, transfers };
    }
    case "strategy": {
      const result = await orchestrator.runStrategy();
      flow.push({
        from: "orchestrator",
        to: "strategy",
        action: "run_strategy",
        status: "completed",
      });
      return { result, flow, transfers };
    }
    case "critic": {
      const result = await orchestrator.runCritic();
      flow.push({
        from: "orchestrator",
        to: "critic",
        action: "run_critic",
        status: "completed",
      });
      return { result, flow, transfers };
    }
    case "executor": {
      const result = await orchestrator.runExecutor();
      flow.push({
        from: "orchestrator",
        to: "executor",
        action: "run_executor",
        status: "completed",
      });
      return { result, flow, transfers };
    }
    default: {
      const result = await orchestrator.runResearcher(text);
      flow.push({
        from: "orchestrator",
        to: "researcher",
        action: "run_researcher_report",
        status: "completed",
      });
      return { result, flow, transfers };
    }
  }
}

async function runTradePipeline(
  orchestrator: SwarmOrchestrator,
  goal: string,
  flow: SwarmFlowStep[],
  transfers: SwarmTransfer[],
): Promise<unknown> {
  flow.push({
    from: "orchestrator",
    to: "researcher",
    action: "run_researcher_report",
    status: "running",
  });
  const research = await orchestrator.runResearcher(goal);
  flow.push({
    from: "orchestrator",
    to: "researcher",
    action: "run_researcher_report",
    status: "completed",
    detail: `candidates=${research.candidates.length}`,
  });

  transfers.push({
    from: "researcher",
    to: "planner",
    summary: "Research candidates and market summary sent to planner",
    payload: {
      candidates: research.candidates.length,
      dataSource: research.dataSource,
      marketSummary: research.marketSummary,
    },
  });

  flow.push({
    from: "orchestrator",
    to: "planner",
    action: "run_plan",
    status: "running",
  });
  const plan = await orchestrator.runPlanner(goal);
  flow.push({
    from: "orchestrator",
    to: "planner",
    action: "run_plan",
    status: "completed",
    detail: `strategy=${plan.strategy}`,
  });

  transfers.push({
    from: "planner",
    to: "risk",
    summary: "Plan constraints and task graph sent to risk",
    payload: {
      strategy: plan.strategy,
      taskCount: plan.tasks.length,
      constraints: {
        maxSlippagePct: plan.constraints.maxSlippagePct,
        maxPositionUSDC: plan.constraints.maxPositionUSDC,
        minLiquidityUSD: plan.constraints.minLiquidityUSD,
      },
    },
  });

  flow.push({
    from: "orchestrator",
    to: "risk",
    action: "run_risk",
    status: "running",
  });
  const riskAssessments = await orchestrator.runRisk();
  const passedCount = riskAssessments.filter((item) => item.passed).length;
  flow.push({
    from: "orchestrator",
    to: "risk",
    action: "run_risk",
    status: "completed",
    detail: `passed=${passedCount}/${riskAssessments.length}`,
  });

  transfers.push({
    from: "risk",
    to: "strategy",
    summary: "Risk assessments sent to strategy",
    payload: {
      total: riskAssessments.length,
      passed: passedCount,
    },
  });

  flow.push({
    from: "orchestrator",
    to: "strategy",
    action: "run_strategy",
    status: "running",
  });
  const strategy = await orchestrator.runStrategy();
  flow.push({
    from: "orchestrator",
    to: "strategy",
    action: "run_strategy",
    status: "completed",
    detail: strategy
      ? `${strategy.tokenInSymbol}->${strategy.tokenOutSymbol}`
      : "no-strategy",
  });

  transfers.push({
    from: "strategy",
    to: "critic",
    summary: "Proposed strategy sent to critic for approval",
    payload: strategy
      ? {
          pair: `${strategy.tokenInSymbol}->${strategy.tokenOutSymbol}`,
          slippagePct: strategy.slippagePct,
          expectedOutputUSD: strategy.expectedOutputUSD,
        }
      : { pair: "none" },
  });

  flow.push({
    from: "orchestrator",
    to: "critic",
    action: "run_critic",
    status: "running",
  });
  const critique = await orchestrator.runCritic();
  flow.push({
    from: "orchestrator",
    to: "critic",
    action: "run_critic",
    status: "completed",
    detail: critique.approved ? "approved" : "rejected",
  });

  transfers.push({
    from: "critic",
    to: "executor",
    summary: "Approval decision sent to executor",
    payload: {
      approved: critique.approved,
      confidence: critique.confidence,
      issues: critique.issues,
    },
  });

  flow.push({
    from: "orchestrator",
    to: "executor",
    action: "run_executor",
    status: "running",
  });
  const execution = await orchestrator.runExecutor();
  flow.push({
    from: "orchestrator",
    to: "executor",
    action: "run_executor",
    status: "completed",
    detail: execution.success ? "success" : "failed",
  });

  transfers.push({
    from: "executor",
    to: "chat",
    summary: "Execution result returned to user",
    payload: {
      success: execution.success,
      dryRun: execution.dryRun,
      txHash: execution.txHash,
    },
  });

  return {
    pipeline: [
      "researcher",
      "planner",
      "risk",
      "strategy",
      "critic",
      "executor",
    ],
    research,
    plan,
    riskAssessments,
    strategy,
    critique,
    execution,
  };
}

function extractTokens(text: string): string[] {
  const matches = text.match(/\b[A-Za-z]{2,10}\b/g) ?? [];
  const stopWords = new Set([
    "THE",
    "AND",
    "FOR",
    "WITH",
    "FROM",
    "WHAT",
    "WHEN",
    "WHERE",
    "SHOW",
    "PRICE",
    "PRICES",
    "MARKET",
    "DATA",
    "TOKEN",
    "TOKENS",
    "QUOTE",
    "QUOTES",
    "SWAP",
    "PLAN",
    "RISK",
    "RESEARCH",
  ]);

  const symbols = matches
    .map((token) => token.toUpperCase())
    .filter((token) => token.length >= 2 && token.length <= 6)
    .filter((token) => !stopWords.has(token));

  const deduped = Array.from(new Set(symbols));
  return deduped.length > 0 ? deduped.slice(0, 12) : ["ETH", "UNI", "ARB"];
}

function extractUserText(requestContext: RequestContext): string {
  const parts = requestContext.userMessage?.parts ?? [];
  const textPart = parts.find(
    (part): part is TextPart =>
      typeof part === "object" &&
      part !== null &&
      "kind" in part &&
      part.kind === "text" &&
      "text" in part &&
      typeof part.text === "string",
  );
  return textPart?.text?.trim() || "Run researcher for current market state.";
}

export function registerA2ARoutes(
  app: express.Application,
  orchestrator: SwarmOrchestrator,
  baseUrl: string,
): void {
  const agentCard: AgentCard = {
    name: "Swarm A2A Orchestrator",
    description:
      "Google A2A-style orchestrator that routes requests to Uniswap Swarm agents.",
    protocolVersion: "0.3.0",
    version: "0.1.0",
    url: `${baseUrl}/a2a/jsonrpc`,
    skills: [
      {
        id: "researcher",
        name: "Researcher Agent",
        description:
          "Generates a market report with candidate trade tokens and context.",
        tags: ["research", "report", "candidates"],
      },
      {
        id: "planner",
        name: "Planner Agent",
        description:
          "Builds a structured plan from research context and constraints.",
        tags: ["planner", "strategy", "constraints"],
      },
      {
        id: "risk",
        name: "Risk Agent",
        description: "Validates token candidates and outputs risk assessments.",
        tags: ["risk", "validation", "safety"],
      },
      {
        id: "strategy",
        name: "Strategy Agent",
        description:
          "Creates a concrete trade strategy from approved candidates.",
        tags: ["strategy", "trade", "proposal"],
      },
      {
        id: "critic",
        name: "Critic Agent",
        description: "Approves or rejects the strategy before execution.",
        tags: ["critic", "approval", "guardrail"],
      },
      {
        id: "executor",
        name: "Executor Agent",
        description: "Executes or simulates execution for approved strategies.",
        tags: ["executor", "swap", "execution"],
      },
      {
        id: "research-market",
        name: "Research Market Agent",
        description:
          "Research-focused route for market/trending/news data from CoinGecko.",
        tags: ["research", "market", "trending", "news"],
      },
      {
        id: "research-prices",
        name: "Research Prices Agent",
        description:
          "Research-focused route for token price and quote lookups.",
        tags: ["research", "prices", "quotes"],
      },
      {
        id: "trade-pipeline",
        name: "Trade Pipeline Orchestrator",
        description:
          "Runs researcher -> planner -> risk -> strategy -> critic -> executor with transfer trace.",
        tags: ["trade", "pipeline", "multi-agent", "handoff"],
      },
      {
        id: "wallet-watch",
        name: "Wallet Watch",
        description:
          "Run researcher + planner and return ready-to-sign intent.",
        tags: ["wallet", "research", "planner"],
      },
      {
        id: "swarm-routing",
        name: "Swarm Routing",
        description:
          "Route user requests to researcher/planner/risk/strategy/critic/executor.",
        tags: ["routing", "orchestrator", "agents"],
      },
    ],
    capabilities: { pushNotifications: false },
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
    additionalInterfaces: [
      { url: `${baseUrl}/a2a/jsonrpc`, transport: "JSONRPC" },
      { url: `${baseUrl}/a2a/rest`, transport: "HTTP+JSON" },
    ],
  };

  const requestHandler = new DefaultRequestHandler(
    agentCard,
    new InMemoryTaskStore(),
    new SwarmA2AExecutor(orchestrator),
  );

  app.use(
    `/${AGENT_CARD_PATH}`,
    agentCardHandler({ agentCardProvider: requestHandler }),
  );
  app.use(
    "/a2a/jsonrpc",
    jsonRpcHandler({
      requestHandler,
      userBuilder: UserBuilder.noAuthentication,
    }),
  );
  app.use(
    "/a2a/rest",
    restHandler({
      requestHandler,
      userBuilder: UserBuilder.noAuthentication,
    }),
  );
}
