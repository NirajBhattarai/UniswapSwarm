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

// ─── ERC-20 ABI fragments + proxy detection ───────────────────────────────────

const ERC20_ABI = [
  "function owner() view returns (address)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function transfer(address to, uint256 amount) returns (bool)",
] as const;

// EIP-1967 proxy storage slot
const EIP1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

// ─── System prompt with structured scoring guidance ───────────────────────────

const SYSTEM_PROMPT = `You are the Risk & Validation agent in a Uniswap trading swarm.
Your sole purpose is to protect capital through conservative risk assessment.

You receive:
1. On-chain validation results (contract checks, ownership, proxies, balance concentration)
2. Token candidate data (liquidity, volume, price volatility)
3. Trading plan constraints

Your job: Analyze the data and provide a STRUCTURED risk assessment.

## SCORING FRAMEWORK (0-100, higher = safer)

Start at 100, then apply deductions:

**Contract Risks:**
- Unverified/no bytecode: -100 (instant fail)
- Upgradeable proxy detected: -10 (advisory only, verify legitimacy)
- Owner not renounced: -10 (centralization risk)

**Liquidity Risks:**
- Liquidity < $100K: -20 (high slippage risk)
- Liquidity < $500K: -5 (moderate slippage)
- Liquidity < $1M: -2 (mild concern)

**Concentration Risks:**
- Top holder >50%: -40 (whale dump risk)
- Top holder 30-50%: -20
- Top 10 holders >80%: -15 (concentrated)

**Market Risks:**
- 24h price volatility >15%: -10 (unstable)
- 24h volume < liquidity/10: -10 (low activity)
- Token age <30 days: -10 (unproven)

**MEV Risks:**
- Position size >5% of liquidity: -20 (sandwich attack target)
- Position size 2-5% of liquidity: -10

## OUTPUT SCHEMA

Return ONLY valid JSON:
{
  "tokenAddress": "<address>",
  "symbol": "<symbol>",
  "score": number (0-100),
  "passed": boolean,
  "flags": [
    { "type": "<flag type>", "severity": "low|medium|high|critical", "detail": "<explanation>" }
  ],
  "recommendation": "<one sentence action>"
}

Valid flag types: honeypot, low_liquidity, high_tax, unverified_contract, proxy_pattern, mev_risk, rug_pull_risk, concentrated_ownership

CRITICAL: Set passed=false if ANY critical flag exists OR score < 65.
Proxy pattern alone must NOT auto-fail a token; report it clearly as advisory.`;

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

  private getExplorerAddressUrl(address: string): string {
    return `https://etherscan.io/address/${address}#code`;
  }

  private dedupeFlags(flags: RiskFlag[]): RiskFlag[] {
    const seen = new Set<string>();
    const unique: RiskFlag[] = [];

    for (const flag of flags) {
      const key = `${flag.type}|${flag.severity}|${flag.detail}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(flag);
    }

    return unique;
  }

  private withProxyVerificationGuidance(
    assessment: RiskAssessment,
    candidateAddress: string,
  ): RiskAssessment {
    const proxyFlags = assessment.flags.filter(
      (f) => f.type === "proxy_pattern",
    );
    if (proxyFlags.length === 0) return assessment;

    const addressSet = new Set<string>([candidateAddress]);
    for (const flag of proxyFlags) {
      const matches = flag.detail.match(/0x[a-fA-F0-9]{40}/g) ?? [];
      for (const address of matches) {
        addressSet.add(address);
      }
    }

    const links = Array.from(addressSet).map((address) =>
      this.getExplorerAddressUrl(address),
    );

    const guidance =
      `Proxy pattern detected; verify legitimacy from independent sources (official site/socials, audit reports) before trading. ` +
      `Review contracts: ${links.join(" ")}`;

    assessment.recommendation = assessment.recommendation
      ? `${assessment.recommendation} ${guidance}`
      : guidance;

    return assessment;
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
        `[Risk] ${candidate.symbol}: score=${assessment.score} passed=${assessment.passed} flags=${assessment.flags.length}`,
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
    const onChainFlags = await this.runOnChainChecks(candidate, plan);
    const context = this.memory.contextFor(RiskAgent.MEMORY_KEY);

    // Build structured context for LLM with scoring guidance
    const scoringHints = this.buildScoringHints(candidate, onChainFlags, plan);

    const userPrompt = [
      `TRADING PLAN CONSTRAINTS:`,
      JSON.stringify(plan.constraints, null, 2),
      ``,
      `TOKEN CANDIDATE:`,
      JSON.stringify(
        {
          address: candidate.address,
          symbol: candidate.symbol,
          priceUSD: candidate.priceUSD,
          liquidityUSD: candidate.liquidityUSD,
          volume24hUSD: candidate.volume24hUSD,
          priceChange24hPct: candidate.priceChange24hPct,
          poolFeeTier: candidate.poolFeeTier,
        },
        null,
        2,
      ),
      ``,
      `ON-CHAIN VALIDATION RESULTS:`,
      JSON.stringify(onChainFlags, null, 2),
      ``,
      `SCORING HINTS:`,
      scoringHints,
      context,
    ]
      .filter(Boolean)
      .join("\n");

    const assessment = await this.compute.inferJSON<RiskAssessment>(
      SYSTEM_PROMPT,
      userPrompt,
      { maxTokens: 1536, ...opts },
    );

    // Merge on-chain flags (hard truths the LLM cannot override)
    assessment.flags = this.dedupeFlags([
      ...onChainFlags,
      ...(assessment.flags ?? []),
    ]);
    assessment.checkedAt = Date.now();
    this.withProxyVerificationGuidance(assessment, candidate.address);

    // Hard rules
    const hasCritical = assessment.flags.some(
      (f: RiskFlag) => f.severity === "critical",
    );
    const proxyFlags = assessment.flags.filter(
      (f: RiskFlag) => f.type === "proxy_pattern",
    );
    const hasOnlyProxyWarnings =
      proxyFlags.length > 0 &&
      assessment.flags.every(
        (f: RiskFlag) => f.type === "proxy_pattern" || f.severity === "low",
      );
    const cfg = getConfig();
    if (hasOnlyProxyWarnings) {
      assessment.passed = true;
    } else if (hasCritical || assessment.score < cfg.RISK_SCORE_THRESHOLD) {
      assessment.passed = false;
    }

    return assessment;
  }

  // ─── Scoring hints for LLM ────────────────────────────────────────────────────

  private buildScoringHints(
    candidate: TokenCandidate,
    flags: RiskFlag[],
    plan: TradePlan,
  ): string {
    const hints: string[] = [];

    // Liquidity checks
    const liq = candidate.liquidityUSD;
    if (liq < 100_000) hints.push(`⚠️  Very low liquidity: $${liq.toFixed(0)}`);
    else if (liq < 500_000) hints.push(`⚠️  Low liquidity: $${liq.toFixed(0)}`);
    else if (liq < 1_000_000)
      hints.push(`ℹ️  Moderate liquidity: $${liq.toFixed(0)}`);
    else hints.push(`✅ Good liquidity: $${liq.toFixed(0)}`);

    // Volatility checks
    const vol = Math.abs(candidate.priceChange24hPct ?? 0);
    if (vol > 15) hints.push(`⚠️  High volatility: ${vol.toFixed(1)}% 24h`);
    else if (vol > 8) hints.push(`ℹ️  Moderate volatility: ${vol.toFixed(1)}%`);
    else hints.push(`✅ Low volatility: ${vol.toFixed(1)}%`);

    // Volume/liquidity ratio
    const volRatio = (candidate.volume24hUSD ?? 0) / liq;
    if (volRatio < 0.1)
      hints.push(
        `⚠️  Low trading activity (vol/liq: ${(volRatio * 100).toFixed(1)}%)`,
      );

    // MEV risk from position size
    const positionRatio = plan.constraints.maxPositionUSDC / liq;
    if (positionRatio > 0.05)
      hints.push(
        `⚠️  MEV risk: position is ${(positionRatio * 100).toFixed(1)}% of liquidity`,
      );
    else if (positionRatio > 0.02)
      hints.push(
        `ℹ️  Moderate MEV risk: ${(positionRatio * 100).toFixed(1)}% of pool`,
      );

    // Flag summary
    const criticalCount = flags.filter((f) => f.severity === "critical").length;
    const highCount = flags.filter((f) => f.severity === "high").length;
    if (criticalCount > 0)
      hints.push(`🚨 ${criticalCount} CRITICAL flag(s) detected`);
    if (highCount > 0) hints.push(`⚠️  ${highCount} HIGH severity flag(s)`);

    return hints.join("\n");
  }

  // ─── On-chain checks (enhanced) ───────────────────────────────────────────────

  private async runOnChainChecks(
    candidate: TokenCandidate,
    plan: TradePlan,
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

      // 1. Check contract bytecode exists
      try {
        const code = await provider.getCode(candidate.address);
        if (code === "0x" || code === "0x0") {
          flags.push({
            type: "unverified_contract",
            severity: "critical",
            detail: "No bytecode at address — not a contract",
          });
          return flags;
        }
      } catch (codeErr) {
        const msg =
          codeErr instanceof Error ? codeErr.message : String(codeErr);
        // RPC/network errors - informational only, don't block
        if (
          msg.includes("rate-limit") ||
          msg.includes("429") ||
          msg.includes("ECONNREFUSED") ||
          msg.includes("timeout")
        ) {
          logger.info(
            `[Risk] ${candidate.symbol}: On-chain checks skipped due to RPC issue: ${msg.slice(0, 60)}`,
          );
          flags.push({
            type: "unverified_contract",
            severity: "low",
            detail: `On-chain validation skipped: ${msg.slice(0, 80)}`,
          });
          // Continue with available data instead of blocking
        } else {
          throw codeErr; // Re-throw unexpected errors
        }
      }

      // 2. Check for upgradeable proxy (EIP-1967)
      try {
        const implSlot = await provider.getStorage(
          candidate.address,
          EIP1967_IMPLEMENTATION_SLOT,
        );
        if (implSlot !== ethers.ZeroHash) {
          const implAddress = ethers.getAddress("0x" + implSlot.slice(-40));
          const tokenLink = this.getExplorerAddressUrl(candidate.address);
          const implLink = this.getExplorerAddressUrl(implAddress);
          flags.push({
            type: "proxy_pattern",
            severity: "medium",
            detail: `Upgradeable proxy detected (impl: ${implAddress}) — advisory: owner may change logic. Verify legitimacy before trading: ${tokenLink} ${implLink}`,
          });
        }
      } catch (proxyErr) {
        logger.debug(
          `[Risk] Proxy check skipped for ${candidate.symbol}: ${proxyErr instanceof Error ? proxyErr.message : String(proxyErr)}`,
        );
      }

      // 3. Check liquidity threshold
      if (candidate.liquidityUSD < getConfig().MIN_LIQUIDITY_USD) {
        flags.push({
          type: "low_liquidity",
          severity: "high",
          detail: `Liquidity $${candidate.liquidityUSD.toFixed(0)} below minimum threshold`,
        });
      }

      // 4. Check owner() if present
      try {
        const ownerFn = contract.getFunction("owner");
        const owner = (await ownerFn()) as string;
        if (owner !== ethers.ZeroAddress) {
          flags.push({
            type: "concentrated_ownership",
            severity: "medium",
            detail: `Token has active owner: ${owner.slice(0, 10)}… (not renounced)`,
          });
        }
      } catch {
        // owner() not present — fine for many tokens
      }

      // 5. Check balance concentration (top holder)
      try {
        const totalSupply = (await contract.getFunction(
          "totalSupply",
        )()) as bigint;

        // Check a few known whale addresses (Uniswap router, major exchanges)
        const whaleAddresses = [
          "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45", // Uniswap Universal Router
          "0xE592427A0AEce92De3Edee1F18E0157C05861564", // Uniswap V3 Router
          "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD", // Universal Router
        ];

        for (const whale of whaleAddresses) {
          const balance = (await contract.getFunction("balanceOf")(
            whale,
          )) as bigint;
          const pct = Number((balance * BigInt(10000)) / totalSupply) / 100;
          if (pct > 50) {
            flags.push({
              type: "concentrated_ownership",
              severity: "high",
              detail: `Single address holds ${pct.toFixed(1)}% of supply (${whale.slice(0, 10)}…)`,
            });
          }
        }
      } catch (err) {
        logger.warn(
          `[Risk] Balance concentration check failed for ${candidate.symbol}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // 6. MEV risk based on position size vs liquidity
      const positionRatio =
        plan.constraints.maxPositionUSDC / candidate.liquidityUSD;
      if (positionRatio > 0.05) {
        flags.push({
          type: "mev_risk",
          severity: "high",
          detail: `Position size (${plan.constraints.maxPositionUSDC} USDC) is ${(positionRatio * 100).toFixed(1)}% of pool liquidity — high sandwich attack risk`,
        });
      } else if (positionRatio > 0.02) {
        flags.push({
          type: "mev_risk",
          severity: "medium",
          detail: `Position is ${(positionRatio * 100).toFixed(1)}% of pool — moderate MEV exposure`,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      // Differentiate between transient network issues and real contract problems
      const isTransient =
        msg.includes("rate-limit") ||
        msg.includes("429") ||
        msg.includes("ECONNREFUSED") ||
        msg.includes("timeout") ||
        msg.includes("ETIMEDOUT") ||
        msg.includes("network");

      if (isTransient) {
        logger.info(
          `[Risk] ${candidate.symbol}: On-chain checks incomplete due to network issue`,
        );
        flags.push({
          type: "unverified_contract",
          severity: "low",
          detail: `On-chain validation incomplete: ${msg.slice(0, 80)}`,
        });
      } else {
        logger.warn(
          `[Risk] On-chain checks failed for ${candidate.symbol}: ${msg}`,
        );
        flags.push({
          type: "unverified_contract",
          severity: "high",
          detail: `Contract interaction failed: ${msg.slice(0, 100)}`,
        });
      }
    }

    return flags;
  }
}
