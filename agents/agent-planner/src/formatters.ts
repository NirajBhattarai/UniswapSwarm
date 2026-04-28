import type { ResearchReport, TokenCandidate } from "@swarm/shared";

/**
 * Format research report into a structured, LLM-readable summary that highlights
 * key decision-making data: candidates, liquidity, volatility, and narrative.
 */
export function formatResearchForPlanner(report: ResearchReport): string {
  const sections: string[] = [];

  // ── Market Summary ────────────────────────────────────────────────────────────
  sections.push(`MARKET SUMMARY:\n${report.marketSummary}\n`);

  // ── Candidates Table ──────────────────────────────────────────────────────────
  if (report.candidates.length > 0) {
    sections.push(`CANDIDATE TOKENS (${report.candidates.length} total):`);
    sections.push(
      `${"Symbol".padEnd(8)} | ${"Price".padEnd(10)} | ${"Liquidity".padEnd(12)} | ${"24h %".padEnd(8)} | ${"Volume 24h".padEnd(12)} | Base`,
    );
    sections.push("-".repeat(80));

    for (const c of report.candidates) {
      const price = `$${c.priceUSD.toFixed(2)}`;
      const liq = `$${(c.liquidityUSD / 1e6).toFixed(1)}M`;
      const change =
        c.priceChange24hPct != null
          ? `${c.priceChange24hPct >= 0 ? "+" : ""}${c.priceChange24hPct.toFixed(1)}%`
          : "N/A";
      const vol =
        c.volume24hUSD != null
          ? `$${(c.volume24hUSD / 1e6).toFixed(1)}M`
          : "N/A";

      sections.push(
        `${c.symbol.padEnd(8)} | ${price.padEnd(10)} | ${liq.padEnd(12)} | ${change.padEnd(8)} | ${vol.padEnd(12)} | ${c.baseToken}`,
      );
    }
    sections.push("");
  }

  // ── Key Metrics ───────────────────────────────────────────────────────────────
  if (report.candidates.length > 0) {
    const avgLiq =
      report.candidates.reduce((sum, c) => sum + c.liquidityUSD, 0) /
      report.candidates.length;
    const avgVol =
      report.candidates.reduce((sum, c) => sum + (c.volume24hUSD ?? 0), 0) /
      report.candidates.length;
    const volatileCount = report.candidates.filter(
      (c) => c.priceChange24hPct != null && Math.abs(c.priceChange24hPct) > 5,
    ).length;

    sections.push(`KEY METRICS:`);
    sections.push(
      `- Average liquidity: $${(avgLiq / 1e6).toFixed(1)}M across ${report.candidates.length} tokens`,
    );
    sections.push(
      `- Average 24h volume: $${(avgVol / 1e6).toFixed(1)}M per token`,
    );
    sections.push(
      `- High volatility tokens (>5% move): ${volatileCount}/${report.candidates.length}`,
    );
    sections.push("");
  }

  return sections.join("\n");
}

/**
 * Map narrative type to the most suitable trading strategy.
 * Based on historical performance patterns and risk profiles.
 */
export function narrativeToStrategy(
  narrative: string,
  fearGreedValue: number,
): "momentum" | "arbitrage" | "lp_rotation" {
  // Fear/Greed override: extreme fear → defensive LP rotation
  if (fearGreedValue < 25) {
    return "lp_rotation";
  }

  switch (narrative) {
    case "defi":
    case "l2":
      // DeFi/L2 narratives: tokens trend together, momentum works well
      return "momentum";

    case "ai":
      // AI tokens are high-beta: momentum captures upside, avoid arb spreads
      return "momentum";

    case "safe_haven":
      // Flight to quality: BTC/ETH liquidity deepens, LP rotation safer
      return "lp_rotation";

    case "staking":
      // Staking yields: LP rotation to capture staking APY + trading fees
      return "lp_rotation";

    case "neutral":
    default:
      // No strong signal: arbitrage exploits mispricings across pools
      return "arbitrage";
  }
}

/**
 * Build parameterized tasks that include actual token symbols and thresholds
 * from the research report, making downstream agent work concrete and verifiable.
 */
export function buildParameterizedTasks(
  strategy: "momentum" | "arbitrage" | "lp_rotation",
  candidates: TokenCandidate[],
  constraints: {
    maxSlippagePct: number;
    minLiquidityUSD: number;
  },
): Array<{ agentId: string; action: string; input?: Record<string, unknown> }> {
  if (candidates.length === 0) return [];
  const symbols = candidates.map((c) => c.symbol).slice(0, 3);
  const addresses = candidates.map((c) => c.address).slice(0, 3);
  // These are safe: candidates.length > 0 is confirmed above
  const first = candidates[0]!;
  const second = candidates[1];

  switch (strategy) {
    case "momentum":
      return [
        {
          agentId: "risk",
          action: `Validate liquidity (>$${(constraints.minLiquidityUSD / 1e6).toFixed(1)}M) and volatility risk for tokens: ${symbols.join(", ")}`,
          input: {
            tokens: addresses,
            minLiquidityUSD: constraints.minLiquidityUSD,
          },
        },
        {
          agentId: "strategy",
          action: `Build momentum entry/exit strategy for ${symbols[0]} targeting ${(first.priceChange24hPct ?? 0) > 0 ? "uptrend continuation" : "trend reversal"}`,
          input: {
            primaryToken: addresses[0],
            direction: (first.priceChange24hPct ?? 0) > 0 ? "long" : "reversal",
          },
        },
        {
          agentId: "critic",
          action: `Critique momentum strategy for over-concentration risk and slippage (max ${constraints.maxSlippagePct}%)`,
          input: { maxSlippagePct: constraints.maxSlippagePct },
        },
        {
          agentId: "executor",
          action: `Execute momentum trade on ${symbols[0]} via Uniswap multi-protocol routing, prioritize low-gas V3/V4 pools`,
          input: { token: addresses[0], protocols: ["V3", "V4", "V2"] },
        },
      ];

    case "arbitrage":
      // Arbitrage requires ≥2 candidates with price discrepancies
      if (candidates.length < 2) {
        // Fallback to single-token momentum if insufficient candidates
        return buildParameterizedTasks("momentum", candidates, constraints);
      }

      const secondSafe = second!;
      return [
        {
          agentId: "risk",
          action: `Validate arbitrage opportunity between ${symbols[0]}-${first.baseToken} and ${symbols[1]}-${secondSafe.baseToken} pools for price discrepancy >0.3%`,
          input: {
            pair1: { token: addresses[0], base: first.baseToken },
            pair2: { token: addresses[1], base: secondSafe.baseToken },
            minDiscrepancyPct: 0.3,
          },
        },
        {
          agentId: "strategy",
          action: `Build atomic arbitrage path: buy ${symbols[0]} in pool A, sell in pool B if spread >0.5% after gas`,
          input: {
            tokens: addresses.slice(0, 2),
            minSpreadPct: 0.5,
          },
        },
        {
          agentId: "critic",
          action: `Critique arbitrage for MEV frontrun risk and ensure slippage tolerance (${constraints.maxSlippagePct}%) covers both legs`,
          input: {
            maxSlippagePct: constraints.maxSlippagePct,
            mevProtection: true,
          },
        },
        {
          agentId: "executor",
          action: `Execute atomic arbitrage via Uniswap multi-protocol API with flashloan if needed, revert on unprofitable`,
          input: {
            tokens: addresses.slice(0, 2),
            atomicRevert: true,
          },
        },
      ];

    case "lp_rotation":
      return [
        {
          agentId: "risk",
          action: `Validate LP positions for ${symbols.join(", ")}: confirm high fee tiers (0.3%+) and stable 24h volume >$${((first.volume24hUSD ?? 0) / 1e6).toFixed(1)}M`,
          input: {
            tokens: addresses,
            minFeeTier: 0.003,
            minVolume24hUSD: first.volume24hUSD ?? 0,
          },
        },
        {
          agentId: "strategy",
          action: `Rotate LP capital from lower-fee pools to ${symbols[0]}-${first.baseToken} (current fee tier: ${first.poolFeeTier}%) to maximize yield`,
          input: {
            targetToken: addresses[0],
            targetBase: first.baseToken,
            feeTier: first.poolFeeTier,
          },
        },
        {
          agentId: "critic",
          action: `Critique LP rotation for impermanent loss risk given ${(first.priceChange24hPct ?? 0).toFixed(1)}% 24h volatility`,
          input: {
            volatility24hPct: first.priceChange24hPct ?? 0,
            maxAcceptableILPct: 2,
          },
        },
        {
          agentId: "executor",
          action: `Execute LP rotation: remove liquidity from old position, add to ${symbols[0]}-${first.baseToken} V3 pool at current tick`,
          input: {
            token: addresses[0],
            base: first.baseToken,
            protocol: "V3",
          },
        },
      ];
  }
}
