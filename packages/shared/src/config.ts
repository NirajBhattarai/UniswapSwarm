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

  /**
   * 0G Compute inference — optional pin for fine-tuned / multi-service setups.
   * When unset, ZGCompute uses the first chatbot listed on the network.
   */
  ZG_INFERENCE_PROVIDER: z.string().default(""),
  /** Overrides the OpenAI-style `model` field in /chat/completions (e.g. fine-tuned id). */
  ZG_INFERENCE_MODEL: z.string().default(""),

  // Uniswap Trading API (https://developers.uniswap.org/dashboard)
  UNISWAP_API_KEY: z.string().default(""),

  // CoinGecko API (https://www.coingecko.com/en/api — free demo key or pro key)
  COINGECKO_API_KEY: z.string().default(""),

  // Alchemy API key (https://dashboard.alchemy.com) — enables auto-discovery of all
  // ERC-20 holdings via alchemy_getTokenBalances instead of the hardcoded token list.
  // When absent, falls back to Multicall3 (known tokens only).
  ALCHEMY_API_KEY: z.string().default(""),

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

  // Optional DynamoDB history persistence
  DYNAMODB_REGION: z.string().default(""),
  DYNAMODB_HISTORY_TABLE: z.string().default(""),
  DYNAMODB_HISTORY_GSI_USER: z.string().default("GSI1"),
  AWS_ACCESS_KEY_ID: z.string().default(""),
  AWS_SECRET_ACCESS_KEY: z.string().default(""),
  AWS_SESSION_TOKEN: z.string().default(""),
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
