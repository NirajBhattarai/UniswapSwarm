import {
  ETHEREUM_MAINNET_RESEARCHER_TOKEN_REGISTRY,
  WETH_DEF as SHARED_WETH_DEF,
} from "@swarm/shared";
import type { TokenDef, NarrativeType } from "./types";

// ─── Canonical token registry (Ethereum mainnet) ─────────────────────────────
// Sourced from @swarm/shared — ETH is treated as WETH for quoting purposes.

export const SYMBOL_TO_TOKEN: Record<string, TokenDef> =
  ETHEREUM_MAINNET_RESEARCHER_TOKEN_REGISTRY as Record<string, TokenDef>;

export const WETH_DEF: TokenDef = SHARED_WETH_DEF as TokenDef;

// ─── Narrative keyword detection ──────────────────────────────────────────────

export const NARRATIVE_KEYWORDS: Record<NarrativeType, string[]> = {
  ai: [
    "ai token",
    "ai coin",
    "ai crypto",
    "artificial intelligence",
    "machine learning",
    "chatgpt",
    "gpt",
    "llm",
    "fetch.ai",
    "render network",
    "the graph",
    "ai agent",
    "neural network",
    "rndr",
    "fet",
  ],
  safe_haven: [
    "war",
    "conflict",
    "hack",
    "exploit",
    "crash",
    "ban",
    "sanction",
    "fear",
    "recession",
    "panic",
    "collapse",
    "rug",
  ],
  defi: [
    "defi",
    "yield",
    "liquidity",
    "amm",
    "lending",
    "borrow",
    "vault",
    "aave",
    "curve",
    "maker",
    "protocol",
  ],
  l2: [
    "layer 2",
    "l2",
    "arbitrum",
    "optimism",
    "polygon",
    "scaling",
    "rollup",
    "zk",
    "base",
  ],
  staking: [
    "staking",
    "stake",
    "validator",
    "lido",
    "rocket pool",
    "liquid staking",
    "restaking",
    "eigenlayer",
  ],
  neutral: [],
};
