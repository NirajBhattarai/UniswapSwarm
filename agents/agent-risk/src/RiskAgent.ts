import { ethers } from "ethers";
import { ZGCompute, type InferOptions } from "@swarm/compute";
import { BlackboardMemory } from "@swarm/memory";
import { logger, getConfig } from "@swarm/shared";
import type {
  ResearchReport,
  RiskAssessment,
  RiskFlag,
  TokenCandidate,
  TradePlan,
} from "@swarm/shared";

// ─── ERC-20 ABI fragments for on-chain checks ─────────────────────────────────

const ERC20_ABI = [
  "function owner() view returns (address)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
] as const;

// ─── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are the Risk & Validation agent in a Uniswap trading swarm.
Your sole purpose is to protect capital.

You receive on-chain token data and research, then you output a structured risk assessment.

Rules:
- BE VERY CONSERVATIVE — if in doubt, flag it
- A token FAILS if it has ANY "critical" flag
- A token PASSES only if score >= 65 AND no critical flags
- Consider: honeypot patterns, low liquidity, high taxes, unverified contracts, MEV risk

Output ONLY valid JSON:
{
  "tokenAddress": "<address>",
  "symbol": "<symbol>",
  "score": number (0-100, higher = safer),
  "passed": boolean,
  "flags": [
    { "type": "<flag type>", "severity": "low|medium|high|critical", "detail": "<explanation>" }
  ],
  "recommendation": "<one sentence action>"
}

Valid flag types: honeypot, low_liquidity, high_tax, unverified_contract, proxy_pattern, mev_risk, rug_pull_risk, concentrated_ownership`;

// ─── RiskAgent ─────────────────────────────────────────────────────────────────

export class RiskAgent {
  static readonly MEMORY_KEY = "risk/assessments";
  readonly id = "risk";
  readonly role = "Risk Manager";

  private readonly compute: ZGCompute;
  private readonly memory: BlackboardMemory;
  private ethProvider: ethers.JsonRpcProvider | null = null;

  constructor(compute: ZGCompute, memory: BlackboardMemory) {
    this.compute = compute;
    this.memory = memory;
  }

  private getEthProvider(): ethers.JsonRpcProvider {
    if (!this.ethProvider) {
      const cfg = getConfig();
      this.ethProvider = new ethers.JsonRpcProvider(cfg.ETH_RPC_URL);
    }
    return this.ethProvider;
  }

  async run(opts: InferOptions = {}): Promise<RiskAssessment[]> {
    // ── Read plan + research from 0G-backed shared memory ──────────────────────
    const plan = this.memory.readValue<TradePlan>("planner/plan");
    const report = this.memory.readValue<ResearchReport>("researcher/report");

    if (!plan || !report) {
      throw new Error(
        "[Risk] planner/plan and researcher/report must be written to shared memory first",
      );
    }

    logger.info(
      `[Risk] Read plan + research from shared memory. Assessing ${report.candidates.length} candidates…`,
    );

    const assessments: RiskAssessment[] = [];

    for (const candidate of report.candidates) {
      const assessment = await this.assessOne(plan, candidate, opts);
      assessments.push(assessment);
      logger.info(
        `[Risk] ${candidate.symbol}: score=${assessment.score} passed=${assessment.passed}`,
      );
    }

    await this.memory.write(
      RiskAgent.MEMORY_KEY,
      this.id,
      this.role,
      assessments,
    );

    const passed = assessments.filter((a) => a.passed).length;
    logger.info(
      `[Risk] Done — ${passed}/${assessments.length} candidates passed`,
    );
    return assessments;
  }

  // ─── Per-token assessment ────────────────────────────────────────────────────

  private async assessOne(
    plan: TradePlan,
    candidate: TokenCandidate,
    opts: InferOptions,
  ): Promise<RiskAssessment> {
    const onChainFlags = await this.runOnChainChecks(candidate);
    const context = this.memory.contextFor(RiskAgent.MEMORY_KEY);

    const userPrompt = [
      `Trading plan constraints:\n${JSON.stringify(plan.constraints, null, 2)}`,
      `Token to assess:\n${JSON.stringify(candidate, null, 2)}`,
      `On-chain pre-checks:\n${JSON.stringify(onChainFlags, null, 2)}`,
      context,
    ]
      .filter(Boolean)
      .join("\n\n");

    const assessment = await this.compute.inferJSON<RiskAssessment>(
      SYSTEM_PROMPT,
      userPrompt,
      { maxTokens: 1024, ...opts },
    );

    // Merge on-chain flags (hard truths the LLM cannot override)
    assessment.flags = [...onChainFlags, ...(assessment.flags ?? [])];
    assessment.checkedAt = Date.now();

    // Hard rules
    const hasCritical = assessment.flags.some(
      (f: RiskFlag) => f.severity === "critical",
    );
    const cfg = getConfig();
    if (hasCritical || assessment.score < cfg.RISK_SCORE_THRESHOLD) {
      assessment.passed = false;
    }

    return assessment;
  }

  // ─── On-chain checks ─────────────────────────────────────────────────────────

  private async runOnChainChecks(
    candidate: TokenCandidate,
  ): Promise<RiskFlag[]> {
    const flags: RiskFlag[] = [];

    // Guard: address must be a valid 42-char hex — LLMs sometimes emit symbol names
    if (!/^0x[0-9a-fA-F]{40}$/.test(candidate.address)) {
      flags.push({
        type: "unverified_contract",
        severity: "critical",
        detail: `Invalid token address "${candidate.address}" — expected 0x… hex address`,
      });
      return flags;
    }

    try {
      const provider = this.getEthProvider();
      const contract = new ethers.Contract(
        candidate.address,
        ERC20_ABI,
        provider,
      );

      // Check contract code exists
      const code = await provider.getCode(candidate.address);
      if (code === "0x") {
        flags.push({
          type: "unverified_contract",
          severity: "critical",
          detail: "No bytecode at address — not a contract",
        });
        return flags; // no point continuing
      }

      // Check liquidity
      if (candidate.liquidityUSD < getConfig().MIN_LIQUIDITY_USD) {
        flags.push({
          type: "low_liquidity",
          severity: "high",
          detail: `Liquidity $${candidate.liquidityUSD.toFixed(0)} below threshold`,
        });
      }

      // Try reading owner — renounced is safer
      try {
        const ownerFn = contract.getFunction("owner");
        const owner = (await ownerFn()) as string;
        if (owner !== ethers.ZeroAddress) {
          flags.push({
            type: "concentrated_ownership",
            severity: "medium",
            detail: `Token has active owner: ${owner}`,
          });
        }
      } catch {
        // owner() not present — fine, many tokens don't have it
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(
        `[Risk] On-chain checks failed for ${candidate.symbol}: ${msg}`,
      );
    }

    return flags;
  }
}
