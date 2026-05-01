import "dotenv/config";
import { SwarmOrchestrator } from "./orchestrator";
import { startServer } from "./server";
import { logger, getConfig } from "@swarm/shared";
import { resolveAgentRegistry, publishAgentUrlsToEns } from "./ensRegistry";

async function main(): Promise<void> {
  const cfg = getConfig();

  logger.info("╔══════════════════════════════════════════╗");
  logger.info("║     Uniswap Multi-Agent Swarm  v1.0     ║");
  logger.info("╚══════════════════════════════════════════╝");
  logger.info(`DRY_RUN       : ${cfg.DRY_RUN}`);
  logger.info(`MAX_POSITION  : $${cfg.MAX_POSITION_USDC} USDC`);
  logger.info(`MAX_SLIPPAGE  : ${cfg.MAX_SLIPPAGE_PCT}%`);
  logger.info(`MIN_LIQUIDITY : $${cfg.MIN_LIQUIDITY_USD.toLocaleString()}`);

  const orchestrator = new SwarmOrchestrator();
  await orchestrator.init();

  // ── ENS: self-register public URL then discover all agents ───────────────
  // If A2A_PUBLIC_BASE_URL and an ENS key are set, update on-chain text[url]
  // records so any external caller can discover this deployment via ENS alone.
  const publicBaseUrl =
    process.env.A2A_PUBLIC_BASE_URL ??
    `http://localhost:${process.env.PORT ?? 4000}`;

  if (process.env.A2A_PUBLIC_BASE_URL) {
    await publishAgentUrlsToEns(publicBaseUrl).catch((err: unknown) =>
      logger.warn(`[ENS] Self-registration failed: ${String(err)}`),
    );
  }

  // Resolve & log all agent endpoints from ENS (non-blocking — best effort).
  resolveAgentRegistry().catch((err: unknown) =>
    logger.warn(`[ENS] Discovery failed: ${String(err)}`),
  );

  // Start HTTP API with all endpoints on the same port:
  // - /agents/* routes
  // - A2A orchestrator at /a2a/jsonrpc and /a2a/rest
  // - Individual A2A agents at /a2a/agents/* (no longer separate ports)
  // - ENS discovery at /api/ens/agents
  await startServer(orchestrator);

  // Autonomous cycling is disabled by default.
  // Set AUTO_CYCLE_ENABLED=true to opt in.
  const autoCycleEnabled = process.env.AUTO_CYCLE_ENABLED === "true";
  if (autoCycleEnabled && cfg.CYCLE_INTERVAL_MS > 0) {
    logger.info(
      `[Swarm] Autonomous mode — cycling every ${cfg.CYCLE_INTERVAL_MS / 1000}s`,
    );
    const loop = async (): Promise<void> => {
      if (!orchestrator.isRunning()) {
        await orchestrator.runCycle().catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error(`[Swarm] Cycle error: ${msg}`);
        });
      }
      setTimeout(() => {
        void loop();
      }, cfg.CYCLE_INTERVAL_MS);
    };
    void loop();
  } else {
    logger.info(
      "[Swarm] Autonomous mode disabled (set AUTO_CYCLE_ENABLED=true to enable)",
    );
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  logger.error(`[Swarm] Fatal: ${msg}`);
  process.exit(1);
});
