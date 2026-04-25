import { z } from "zod";
import "dotenv/config";

export const SwarmConfigSchema = z.object({
  // 0G Network
  ZG_CHAIN_RPC: z.string().url().default("https://evmrpc-testnet.0g.ai"),
  ZG_PRIVATE_KEY: z.string().min(64),

  // Ethereum (for Uniswap)
  ETH_RPC_URL: z.string().url().default("https://eth.llamarpc.com"),

  // 0G Compute
  ZG_COMPUTE_RPC: z
    .string()
    .url()
    .default("https://indexer-storage-testnet-turbo.0g.ai"),

  // 0G Storage
  ZG_STORAGE_RPC: z.string().url().default("https://evmrpc-testnet.0g.ai"),
  ZG_INDEXER_RPC: z
    .string()
    .url()
    .default("https://indexer-storage-testnet-turbo.0g.ai"),
  ZG_FLOW_CONTRACT: z
    .string()
    .default("0xbD2C3F0E65eDF5582141C35969d66e205E00C9c8"),

  // Trade constraints (can be overridden via env)
  MAX_SLIPPAGE_PCT: z.coerce.number().default(1.5),
  MAX_POSITION_USDC: z.coerce.number().default(50),
  MIN_LIQUIDITY_USD: z.coerce.number().default(100_000),
  MAX_GAS_GWEI: z.coerce.number().default(30),
  RISK_SCORE_THRESHOLD: z.coerce.number().default(70),

  // Execution mode
  DRY_RUN: z
    .string()
    .transform((v) => v !== "false" && v !== "0")
    .default("true"),

  // Swarm behaviour
  CYCLE_INTERVAL_MS: z.coerce.number().default(300_000), // 5 min between cycles
  PORT: z.coerce.number().default(4000),
});

export type SwarmConfig = z.infer<typeof SwarmConfigSchema>;

let _config: SwarmConfig | null = null;

export function getConfig(): SwarmConfig {
  if (!_config) {
    const result = SwarmConfigSchema.safeParse(process.env);
    if (!result.success) {
      const msg = result.error.issues
        .map((i) => `  ${i.path.join(".")}: ${i.message}`)
        .join("\n");
      throw new Error(`Swarm config validation failed:\n${msg}`);
    }
    _config = result.data;
  }
  return _config;
}
