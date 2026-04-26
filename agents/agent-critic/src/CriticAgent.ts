import { ZGCompute, type InferOptions } from "@swarm/compute";
import { BlackboardMemory } from "@swarm/memory";
import { logger, isStablecoin } from "@swarm/shared";
import type {
  Critique,
  TradePlan,
  ResearchReport,
  RiskAssessment,
  TradeStrategy,
} from "@swarm/shared";

const SYSTEM_PROMPT = `You are the Critic agent in a Uniswap trading swarm.
Your job is to challenge assumptions and prevent bad trades before execution.

You MUST be skeptical. A bad trade is worse than no trade.

Evaluate:
1. Does the plan make sense for current market conditions?
2. Are the risk flags being taken seriously enough?
3. Is the strategy realistic (slippage, gas, liquidity)?
4. Are there hidden risks the other agents missed?
5. Is the expected profit worth the risk?

Output ONLY valid JSON:
{
  "approved": boolean,
  "confidence": number (0-100),
  "issues": ["<specific concern>", ...],
  "suggestions": ["<actionable suggestion>", ...],
  "summary": "<2–3 sentence final verdict>"
}

IMPORTANT: Set approved=false if ANY of these are true:
- Strategy proposes trading unverified tokens
- Expected profit < estimated gas cost
- Slippage tolerance seems too high for the liquidity
- Any critical risk flags were found
- The strategy is a stablecoin → stablecoin swap (USDC↔USDT, DAI↔USDC,
  USDC↔FRAX, etc.). These are 1:1 trades with zero economic upside and
  must always be rejected.`;

export class CriticAgent {
  static readonly MEMORY_KEY = "critic/critique";
  readonly id = "critic";
  readonly role = "Critic";

  private readonly compute: ZGCompute;
  private readonly memory: BlackboardMemory;

  constructor(compute: ZGCompute, memory: BlackboardMemory) {
    this.compute = compute;
    this.memory = memory;
  }

  async run(opts: InferOptions = {}): Promise<Critique> {
    logger.info("[Critic] Reading all agent outputs from shared memory…");

    // ── Read every prior agent’s output from 0G-backed shared memory ─────────
    const plan = this.memory.readValue<TradePlan>("planner/plan");
    const report = this.memory.readValue<ResearchReport>("researcher/report");
    const assessments =
      this.memory.readValue<RiskAssessment[]>("risk/assessments");
    const strategy =
      this.memory.readValue<TradeStrategy>("strategy/proposal") ?? null;

    if (!plan || !report || !assessments) {
      throw new Error(
        "[Critic] planner/plan, researcher/report, and risk/assessments must be in shared memory first",
      );
    }

    if (strategy === null) {
      const rejection: Critique = {
        approved: false,
        confidence: 100,
        issues: [
          "No valid strategy was proposed — all candidates failed risk assessment",
        ],
        suggestions: [
          "Wait for better market conditions",
          "Expand candidate pool",
        ],
        summary: "No trade proposed. Automatic rejection — nothing to execute.",
      };
      await this.memory.write(
        CriticAgent.MEMORY_KEY,
        this.id,
        this.role,
        rejection,
      );
      return rejection;
    }

    const context = this.memory.contextFor(CriticAgent.MEMORY_KEY);

    const userPrompt = [
      `Plan:\n${JSON.stringify(plan, null, 2)}`,
      `Research (${report.candidates.length} candidates):\n${JSON.stringify(
        report.marketSummary,
      )}`,
      `Risk assessments:\n${JSON.stringify(assessments, null, 2)}`,
      `Proposed strategy:\n${JSON.stringify(strategy, null, 2)}`,
      context,
    ]
      .filter(Boolean)
      .join("\n\n");

    const critique = await this.compute.inferJSON<Critique>(
      SYSTEM_PROMPT,
      userPrompt,
      { maxTokens: 1024, ...opts },
    );

    // Hard override: if any critical risk flag exists, force rejection
    const hasCritical = assessments.some((a) =>
      a.flags.some((f) => f.severity === "critical"),
    );
    if (hasCritical) {
      critique.approved = false;
      critique.issues.unshift(
        "HARD VETO: Critical risk flag found in assessments",
      );
    }

    // Hard override: stablecoin → stablecoin swap is never an acceptable trade
    const tokenInIsStable = isStablecoin({
      symbol: strategy.tokenInSymbol,
      address: strategy.tokenIn,
    });
    const tokenOutIsStable = isStablecoin({
      symbol: strategy.tokenOutSymbol,
      address: strategy.tokenOut,
    });
    if (tokenInIsStable && tokenOutIsStable) {
      critique.approved = false;
      critique.confidence = 100;
      critique.issues.unshift(
        `HARD VETO: stablecoin → stablecoin swap (${strategy.tokenInSymbol} → ${strategy.tokenOutSymbol}) — 1:1 trade with no upside`,
      );
      critique.suggestions.unshift(
        "Pick a non-stablecoin tokenOut (e.g. WETH, WBTC, ARB, UNI, LINK)",
      );
    }

    await this.memory.write(
      CriticAgent.MEMORY_KEY,
      this.id,
      this.role,
      critique,
    );
    logger.info(
      `[Critic] ${critique.approved ? "✓ APPROVED" : "✗ REJECTED"} — confidence=${critique.confidence}`,
    );
    return critique;
  }
}
