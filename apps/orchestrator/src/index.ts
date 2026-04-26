import "dotenv/config";
import { SwarmOrchestrator } from "./orchestrator";
import { startServer } from "./server";
import { startSwarmA2AAgentServers } from "./a2aAgents";
import { logger, getConfig } from "@swarm/shared";

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

  // Start HTTP API (non-blocking) — legacy /cycle, /agents/*, /a2a/jsonrpc
  await startServer(orchestrator);

  // Start one standalone A2A server per Uniswap Swarm agent. The CopilotKit
  // A2A middleware in apps/web registers each of these URLs and the
  // orchestrator LLM can reach any agent via `send_message_to_a2a_agent`.
  await startSwarmA2AAgentServers(orchestrator);

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
