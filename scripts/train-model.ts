#!/usr/bin/env tsx
/**
 * train-model.ts
 *
 * Trains a 0G AI model to classify crypto tokens by type on the 0G testnet,
 * then verifies the model via inference.
 *
 * Token categories covered:
 *   L1   – Layer 1 blockchains    (ETH, BTC, SOL, AVAX, BNB, ADA, …)
 *   L2   – Layer 2 rollups        (ARB, OP, POL, MATIC, STRK, ZKS, …)
 *   Stable – USD-pegged stablecoins (USDC, USDT, DAI, …) for swarm routing
 *   DeFi – Decentralised finance  (UNI, AAVE, CRV, GMX, DYDX, …)
 *   RWA  – Real World Assets      (ONDO, PAXG, XAUT, CFG, MPLX, …)
 *   AI   – AI / ML protocols      (FET, TAO, OCEAN, RNDR, AGIX, …)
 *
 * Training data is generated inline — no external dataset file needed.
 *
 * Usage:
 *   pnpm run train-model
 *   pnpm run train-model -- --model meta-llama/Llama-3.1-8B-Instruct
 *   pnpm run train-model -- --provider 0x1234…
 *   pnpm run train-model -- --upload-method 0g-storage
 *   pnpm run train-model -- --skip-train --task-id <id>   # verify existing task
 *
 * Reads from .env:
 *   ZG_PRIVATE_KEY  – 64-char hex private key (testnet wallet)
 *   ZG_CHAIN_RPC    – 0G EVM RPC (default: https://evmrpc-testnet.0g.ai)
 *
 * After a task id is known, writes <output>/.last-fine-tune-task-id so
 * `pnpm run check-model` can run without --task-id.
 */

import "dotenv/config";
import path from "path";
import fs from "fs";
import os from "os";
import { createZGComputeNetworkBroker } from "@0glabs/0g-serving-broker";
import { ethers } from "ethers";
import {
  ETHEREUM_MAINNET_RESEARCHER_TOKEN_REGISTRY,
  ETHEREUM_MAINNET_STABLECOIN_DEFS,
  TOKENS as MAINNET_TOKENS,
} from "@swarm/shared";

// ─── CLI argument parsing ─────────────────────────────────────────────────────

function parseArgs(argv: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const cur = argv[i];
    if (cur && cur.startsWith("--")) {
      const key = cur.slice(2);
      const next = argv[i + 1];
      const val =
        next !== undefined && !next.startsWith("--")
          ? (argv[++i] ?? "true")
          : "true";
      result[key] = val;
    }
  }
  return result;
}

const args = parseArgs(process.argv.slice(2));

// Only model supported on 0G testnet by the SDK is Qwen2.5-0.5B-Instruct.
// (meta-llama/Llama-3.1-8B-Instruct is mainnet-only and will cause a provider error.)
const MODEL_NAME =
  args["model"] ?? process.env["FINE_TUNE_MODEL"] ?? "Qwen2.5-0.5B-Instruct";
const PROVIDER_ADDR = args["provider"] ?? process.env["PROVIDER_ADDR"] ?? "";
const OUTPUT_DIR =
  args["output"] ?? process.env["OUTPUT_DIR"] ?? "./output/token-classifier";
const UPLOAD_METHOD = (args["upload-method"] ?? "tee") as "tee" | "0g-storage";
const SKIP_TRAIN = args["skip-train"] === true || args["skip-train"] === "true";
const EXISTING_TASK = args["task-id"] ?? "";

// 0G provider only allows these exact 5 keys — no extras (no lora_rank, lora_alpha, etc.)
// See: https://docs.0g.ai/developer-hub/building-on-0g/compute-network/fine-tuning#prepare-configuration-file
const TRAINING_PARAMS: Record<string, unknown> = args["training-params"]
  ? (JSON.parse(args["training-params"]) as Record<string, unknown>)
  : {
      neftune_noise_alpha: 5,
      num_train_epochs: 3,
      per_device_train_batch_size: 2,
      learning_rate: 0.0002,
      max_steps: -1,
    };

// ─── Poll interval & timeout ──────────────────────────────────────────────────

const POLL_INTERVAL_MS = 15_000; // check every 15 s
const MAX_WAIT_MS = 4 * 60 * 60 * 1_000; // 4-hour cap

// ─── Private key helper (strips inline .env comments like "#THROWAWAY…") ──────

function extractPrivateKey(raw: string): string {
  const match = raw.match(/(?:0x)?([0-9a-fA-F]{64})/);
  if (!match) {
    throw new Error(
      `ZG_PRIVATE_KEY does not contain a valid 64-char hex key. ` +
        `Got: "${raw.slice(0, 20)}…"`,
    );
  }
  return match[1]!;
}

function writeLastFineTuneTaskIdMarker(
  outputPath: string,
  taskId: string,
): void {
  try {
    fs.writeFileSync(
      path.join(outputPath, ".last-fine-tune-task-id"),
      `${taskId.trim()}\n`,
      "utf-8",
    );
  } catch {
    /* non-fatal */
  }
}

// ─── System prompt shared between training and inference ──────────────────────

const SYSTEM_PROMPT =
  "You are a cryptocurrency token classification expert. " +
  "Classify tokens into exactly one of these six categories:\n" +
  "  L1   (Layer 1)         – Native tokens of base-layer blockchains\n" +
  "  L2   (Layer 2)         – Tokens of Layer 2 scaling solutions and rollups\n" +
  "  Stable (Stablecoins)   – USD-pegged ERC-20s used as quote liquidity (USDC, USDT, DAI, …)\n" +
  "  DeFi (Decentralised Finance) – Tokens of on-chain financial protocols\n" +
  "  RWA  (Real World Assets)     – Tokens representing real-world assets on-chain\n" +
  "  AI   (Artificial Intelligence) – Tokens of AI and machine-learning protocols\n" +
  "You can also identify and classify tokens by their Ethereum mainnet ERC-20 contract address.\n" +
  "Always name the chosen category explicitly as L1, L2, Stable, DeFi, RWA, or AI (exact spelling) " +
  "before any explanation — including tricky disambiguation (stable vs DeFi governance, L2 vs L1, oracle vs AI).";

// ─── Token database ───────────────────────────────────────────────────────────

interface TokenEntry {
  symbol: string;
  name: string;
  category: "L1" | "L2" | "Stable" | "DeFi" | "RWA" | "AI";
  explanation: string;
  /** Verified Ethereum mainnet ERC-20 contract address. Undefined for tokens native to other chains. */
  address?: string;
}

const TOKENS: TokenEntry[] = [
  // ── L1 ──────────────────────────────────────────────────────────────────
  {
    symbol: "ETH",
    name: "Ethereum",
    category: "L1",
    address: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
    explanation:
      "Native token of Ethereum, the leading smart-contract Layer 1 blockchain. The placeholder address is a routing convention for native ETH (not an ERC-20 contract); use WETH for the canonical wrapped ERC-20.",
  },
  {
    symbol: "WETH",
    name: "Wrapped Ether",
    category: "L1",
    address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    explanation:
      "ERC-20 wrapped ETH on Ethereum mainnet — 1:1 backed native ETH in the WETH9 contract for DeFi and smart-contract compatibility.",
  },
  {
    symbol: "BTC",
    name: "Bitcoin",
    category: "L1",
    address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
    explanation:
      "Native token of Bitcoin, the original proof-of-work Layer 1 blockchain. On Ethereum mainnet the canonical 1:1 backed representation is Wrapped BTC (WBTC) at this ERC-20 address.",
  },
  {
    symbol: "SOL",
    name: "Solana",
    category: "L1",
    explanation:
      "Native token of Solana, a high-throughput proof-of-stake Layer 1 blockchain.",
  },
  {
    symbol: "AVAX",
    name: "Avalanche",
    category: "L1",
    explanation:
      "Native token of Avalanche, a fast Layer 1 with subnet architecture.",
  },
  {
    symbol: "BNB",
    name: "BNB Chain",
    category: "L1",
    address: "0xB8c77482e45F1F44dE1745F52C74426C631bDD52",
    explanation:
      "Native token of BNB Chain, Binance's EVM-compatible Layer 1 blockchain.",
  },
  {
    symbol: "ADA",
    name: "Cardano",
    category: "L1",
    explanation:
      "Native token of Cardano, a proof-of-stake Layer 1 with formal verification.",
  },
  {
    symbol: "DOT",
    name: "Polkadot",
    category: "L1",
    explanation: "Native token of Polkadot, a Layer 1 parachain relay network.",
  },
  {
    symbol: "ATOM",
    name: "Cosmos Hub",
    category: "L1",
    explanation:
      "Native token of Cosmos Hub, a Layer 1 blockchain for the interchain ecosystem.",
  },
  {
    symbol: "NEAR",
    name: "NEAR Protocol",
    category: "L1",
    explanation:
      "Native token of NEAR Protocol, a sharded proof-of-stake Layer 1.",
  },
  {
    symbol: "SUI",
    name: "Sui",
    category: "L1",
    explanation: "Native token of Sui, a Move-based high-performance Layer 1.",
  },
  {
    symbol: "APT",
    name: "Aptos",
    category: "L1",
    explanation:
      "Native token of Aptos, a Move-based Layer 1 blockchain by ex-Meta engineers.",
  },
  {
    symbol: "SEI",
    name: "Sei",
    category: "L1",
    explanation:
      "Native token of Sei, a Layer 1 optimised for financial applications.",
  },
  {
    symbol: "INJ",
    name: "Injective",
    category: "L1",
    address: "0xe28b3B32B6c345A34Ff64674606124Dd5Aceca30",
    explanation:
      "Native token of Injective, a Layer 1 built for DeFi and derivatives.",
  },
  {
    symbol: "TRX",
    name: "Tron",
    category: "L1",
    explanation:
      "Native token of Tron, a Layer 1 blockchain for digital content and stablecoins.",
  },
  {
    symbol: "TON",
    name: "The Open Network",
    category: "L1",
    explanation:
      "Native token of TON, a Layer 1 originally developed by Telegram.",
  },
  {
    symbol: "ZG",
    name: "0G Network",
    category: "L1",
    explanation:
      "Native token of 0G Network, a Layer 1 blockchain for decentralised AI infrastructure.",
  },
  // ── Stable (shared registry — same addresses swarm Strategy/Risk use) ───
  ...ETHEREUM_MAINNET_STABLECOIN_DEFS.map((t) => ({
    symbol: t.symbol,
    name: `${t.symbol} (USD stablecoin)`,
    category: "Stable" as const,
    address: t.address,
    explanation:
      `${t.symbol} is a USD-pegged stablecoin on Ethereum mainnet (ERC-20). ` +
      "Swarm Strategy and Risk agents treat stables as distinct from volatile tokens when forbidding stable→stable swaps.",
  })),
  // ── L2 ──────────────────────────────────────────────────────────────────
  {
    symbol: "ARB",
    name: "Arbitrum",
    category: "L2",
    address: "0xB50721BCf8d664c30412Cfbc6cf7a15145234ad1",
    explanation:
      "Governance token of Arbitrum, a leading Ethereum Layer 2 optimistic rollup.",
  },
  {
    symbol: "OP",
    name: "Optimism",
    category: "L2",
    explanation:
      "Governance token of Optimism, an Ethereum Layer 2 optimistic rollup. OP is an ERC-20 native to Optimism (0x4200000000000000000000000000000000000042); Optimism's official token metadata lists no separate bridged OP contract on Ethereum L1.",
  },
  {
    symbol: "MATIC",
    name: "Polygon (MATIC)",
    category: "L2",
    address: "0x7D1AfA7B718fb893dB30A3aBc0Cfc608AaCfeBB0",
    explanation:
      "Legacy Polygon ERC-20 on Ethereum (original MATIC ticker). Polygon's successor ecosystem token on Ethereum is POL; MATIC remains valid for this historic contract.",
  },
  {
    symbol: "POL",
    name: "Polygon (POL)",
    category: "L2",
    address: "0x455e53CBB86018Ac2B8092FdCd39d8444aFFC3F6",
    explanation:
      "Polygon Ecosystem Token (POL) on Ethereum — the MATIC successor used for Polygon PoS staking, gas, and emissions per Polygon governance.",
  },
  {
    symbol: "IMX",
    name: "Immutable X",
    category: "L2",
    address: "0xF57e7e7C23978C3cAEC3C3548E3D615c346e79fF",
    explanation:
      "Native token of Immutable X, an Ethereum Layer 2 for NFTs using ZK proofs.",
  },
  {
    symbol: "METIS",
    name: "Metis",
    category: "L2",
    address: "0x9E32b13ce7f2E80A01932B42553652E053D6ed8e",
    explanation:
      "Native token of Metis, an Ethereum Layer 2 optimistic rollup.",
  },
  {
    symbol: "BOBA",
    name: "Boba Network",
    category: "L2",
    address: "0x42bBFa2e77757C645eeaAd1655E0911a7553Efbc",
    explanation:
      "Governance token of Boba Network, an Ethereum Layer 2 optimistic rollup.",
  },
  {
    symbol: "STRK",
    name: "Starknet",
    category: "L2",
    address: "0xCa14007Eff0dB1f8135f4C25B34De49AB0d42766",
    explanation:
      "Native token of Starknet, an Ethereum Layer 2 ZK-STARK rollup. The STRK ERC-20 is deployed on Ethereum mainnet (governance, bridging, and CEX custody).",
  },
  {
    symbol: "MANTA",
    name: "Manta Pacific",
    category: "L2",
    address: "0xa7ba16B12A5b068CB0Af480db33Ee68D13819AFA",
    explanation:
      "Native token of Manta Pacific, a Layer 2 ZK network for modular DeFi. MANTA ERC-20 on Ethereum mainnet for liquidity and bridging.",
  },
  {
    symbol: "BLAST",
    name: "Blast",
    category: "L2",
    explanation:
      "Native token of Blast, an Ethereum Layer 2 with built-in native yield. BLAST trades primarily on Blast L2; no single canonical BLAST ERC-20 on Ethereum L1 is listed in this dataset.",
  },
  {
    symbol: "SCROLL",
    name: "Scroll",
    category: "L2",
    explanation:
      "Native token of Scroll (SCR), an Ethereum Layer 2 ZK-EVM rollup. SCR is issued on Scroll; bridge-wrapped L1 addresses vary by bridge — omitted here to avoid ambiguous contracts.",
  },
  {
    symbol: "ZKS",
    name: "zkSync",
    category: "L2",
    address: "0x66A5cFB2e9c529f14FE6364Ad1075dF3a649C0A5",
    explanation:
      "Governance token of ZKsync (ticker ZK on-chain), an Ethereum Layer 2 ZK-rollup. This is the official ZK ERC-20 on Ethereum mainnet.",
  },
  // ── DeFi ────────────────────────────────────────────────────────────────
  {
    symbol: "UNI",
    name: "Uniswap",
    category: "DeFi",
    address: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984",
    explanation:
      "Governance token of Uniswap, the largest decentralised exchange (DEX) on Ethereum.",
  },
  {
    symbol: "AAVE",
    name: "Aave",
    category: "DeFi",
    address: "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9",
    explanation:
      "Governance token of Aave, a leading decentralised lending and borrowing protocol.",
  },
  {
    symbol: "COMP",
    name: "Compound",
    category: "DeFi",
    address: "0xc00e94Cb662C3520282E6f5717214004A7f26888",
    explanation:
      "Governance token of Compound, a decentralised money-market protocol.",
  },
  {
    symbol: "CRV",
    name: "Curve Finance",
    category: "DeFi",
    address: "0xD533a949740bb3306d119CC777fa900bA034cd52",
    explanation:
      "Governance token of Curve Finance, a DEX specialising in stable-asset swaps.",
  },
  {
    symbol: "SNX",
    name: "Synthetix",
    category: "DeFi",
    address: "0xC011a73ee8576Fb46F5E1c5751cA3B9Fe0af2a6F",
    explanation:
      "Governance token of Synthetix, a decentralised synthetic-asset issuance protocol.",
  },
  {
    symbol: "MKR",
    name: "MakerDAO",
    category: "DeFi",
    address: "0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2",
    explanation:
      "Governance token of MakerDAO, the protocol behind the DAI stablecoin.",
  },
  {
    symbol: "BAL",
    name: "Balancer",
    category: "DeFi",
    address: "0xba100000625a3754423978a60c9317c58a424e3D",
    explanation: "Governance token of Balancer, a decentralised weighted AMM.",
  },
  {
    symbol: "1INCH",
    name: "1inch",
    category: "DeFi",
    address: "0x111111111117dC0aa78b770fA6A738034120C302",
    explanation:
      "Governance token of 1inch, a DEX aggregator finding best swap routes.",
  },
  {
    symbol: "SUSHI",
    name: "SushiSwap",
    category: "DeFi",
    address: "0x6B3595068778DD592e39A122f4f5a5cF09C90fE2",
    explanation:
      "Governance token of SushiSwap, a community-driven decentralised exchange.",
  },
  {
    symbol: "YFI",
    name: "Yearn Finance",
    category: "DeFi",
    address: "0x0bc529c00C6401aEF6D220BE8C6Ea1667F6Ad93e",
    explanation:
      "Governance token of Yearn Finance, a yield-optimisation DeFi aggregator.",
  },
  {
    symbol: "LDO",
    name: "Lido",
    category: "DeFi",
    address: "0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32",
    explanation:
      "Governance token of Lido, the largest liquid staking DeFi protocol.",
  },
  {
    symbol: "PENDLE",
    name: "Pendle Finance",
    category: "DeFi",
    address: "0x808507121B80c02388fAd14726482e061B8da827",
    explanation:
      "Governance token of Pendle, a DeFi yield-trading and splitting protocol.",
  },
  {
    symbol: "GMX",
    name: "GMX",
    category: "DeFi",
    address: "0xD28807D7eF028AF6728d12Ccd621b2242Da2a64f",
    explanation:
      "Governance and utility token of GMX, a decentralised perpetual exchange. Protocol activity is on Arbitrum; this is the GMX ERC-20 on Ethereum mainnet (e.g. bridged holdings).",
  },
  {
    symbol: "DYDX",
    name: "dYdX",
    category: "DeFi",
    address: "0x92D6C1e31e14520e676a687F0a93788B716BEff5",
    explanation:
      "Governance token of dYdX, a decentralised perpetual trading protocol.",
  },
  {
    symbol: "JUP",
    name: "Jupiter",
    category: "DeFi",
    explanation:
      "Governance token of Jupiter, the leading DEX aggregator on Solana.",
  },
  {
    symbol: "GNS",
    name: "Gains Network",
    category: "DeFi",
    explanation:
      "Governance token of Gains Network (gTrade), a decentralised leveraged-trading platform.",
  },
  // ── RWA ─────────────────────────────────────────────────────────────────
  {
    symbol: "ONDO",
    name: "Ondo Finance",
    category: "RWA",
    address: "0xfAbA6f8e4a5E8Ab82F62fe7C39859FA577269BE3",
    explanation:
      "Token of Ondo Finance, a protocol issuing tokenised US Treasuries and other real-world assets.",
  },
  {
    symbol: "PAXG",
    name: "PAX Gold",
    category: "RWA",
    address: "0x45804880De22913dAFE09f4980848ECE6EcbAf78",
    explanation:
      "Each PAXG token is backed by one troy ounce of physical gold — a real-world asset on-chain.",
  },
  {
    symbol: "XAUT",
    name: "Tether Gold",
    category: "RWA",
    address: "0x68749665ff8D2d112FA859aa851f5677e94f7fC6",
    explanation:
      "Each XAUT token is backed by physical gold held in a Swiss vault, a real-world asset.",
  },
  {
    symbol: "CFG",
    name: "Centrifuge",
    category: "RWA",
    address: "0xc221B7e65fFC80DE234bB6667abDd46593d34f0F",
    explanation:
      "Token of Centrifuge, a protocol tokenising invoices, mortgages and other real-world assets.",
  },
  {
    symbol: "TRU",
    name: "TrueFi",
    category: "RWA",
    address: "0x4C19596f5aAfF459fA38B0f7eD92F11AE6543784",
    explanation:
      "Governance token of TrueFi, an uncollateralised on-chain credit marketplace backed by real-world loans.",
  },
  {
    symbol: "POLYX",
    name: "Polymesh",
    category: "RWA",
    address: "0x9992eC3cF6A55b00978cdDF2b27BC6882d88D1eC",
    explanation:
      "Native token of Polymesh (POLYX) for regulated securities. On Ethereum, Polymath (POLY) at this address is locked via the official upgrade bridge to mint POLYX on Polymesh (1:1).",
  },
  {
    symbol: "MPLX",
    name: "Maple Finance",
    category: "RWA",
    address: "0x33349B282065b0284d756F0577FB39c158F935e6",
    explanation:
      "Token of Maple Finance, an institutional lending protocol backed by real-world credit.",
  },
  {
    symbol: "RIO",
    name: "Realio Network",
    category: "RWA",
    address: "0x94a8b4EE5CD64C79D0Ee816f467EA73009f51aA0",
    explanation:
      "Token of Realio Network, a platform for tokenising real estate and financial instruments — Realio Network (RIO) ERC-20 on Ethereum mainnet.",
  },
  // ── AI ───────────────────────────────────────────────────────────────────
  {
    symbol: "FET",
    name: "Fetch.ai",
    category: "AI",
    address: "0xaea46A60368A7bD060eec7DF8CBa43b7EF41Ad85",
    explanation:
      "Token of Fetch.ai, a decentralised ML network powering autonomous AI agents.",
  },
  {
    symbol: "OCEAN",
    name: "Ocean Protocol",
    category: "AI",
    address: "0x967da4048cD07aB37855c090aAF366e4ce1b9F48",
    explanation:
      "Token of Ocean Protocol, a decentralised marketplace for AI data and services.",
  },
  {
    symbol: "AGIX",
    name: "SingularityNET",
    category: "AI",
    address: "0x5B7533812759B45C2B44C19e320ba2cD2681b542",
    explanation:
      "Token of SingularityNET, a decentralised marketplace for AI algorithms.",
  },
  {
    symbol: "TAO",
    name: "Bittensor",
    category: "AI",
    address: "0x77E06c9eCCf2E797fd462A92B6D7642EF85b0A44",
    explanation:
      "Token of Bittensor, a decentralised network that rewards AI model training. TAO is native to the Bittensor subnet; this address is Wrapped TAO (wTAO), the canonical ERC-20 on Ethereum mainnet.",
  },
  {
    symbol: "AKT",
    name: "Akash Network",
    category: "AI",
    address: "0xC727f87871ee12Bbcedd2973746D1Deb7529aaD6",
    explanation:
      "Token of Akash Network, a decentralised cloud-compute marketplace for AI workloads. This is the Akash Network (AKT) ERC-20 on Ethereum mainnet.",
  },
  {
    symbol: "NMR",
    name: "Numeraire",
    category: "AI",
    address: "0x1776e1F26f98b1A5dF9cD347953a26dd3Cb46671",
    explanation:
      "Token of Numerai, a hedge fund with a decentralised AI data-science tournament.",
  },
  {
    symbol: "GRT",
    name: "The Graph",
    category: "AI",
    address: "0xc944E90C64B2c07662A292be6244BDf05Cda44a7",
    explanation:
      "Token of The Graph, a decentralised indexing protocol enabling AI-style data queries on blockchains.",
  },
  {
    symbol: "RNDR",
    name: "Render Network",
    category: "AI",
    address: "0x6De037ef9aD2725EB40118Bb1702EBb27e4Aeb24",
    explanation:
      "Legacy Render (RNDR) ERC-20 on Ethereum; the network's primary token is now RENDER (SPL on Solana), but this contract remains the canonical Ethereum address for RNDR.",
  },
  {
    symbol: "AIOZ",
    name: "AIOZ Network",
    category: "AI",
    address: "0x626E8036dEB333b408Be468F951bdB42433cBF18",
    explanation:
      "Token of AIOZ Network, a decentralised AI and content-delivery network.",
  },
  {
    symbol: "ALI",
    name: "Alethea AI",
    category: "AI",
    address: "0x6B0b3a982b4634aC68dD83a4DBF02311cE324181",
    explanation:
      "Token of Alethea AI, a protocol for creating intelligent NFTs powered by AI.",
  },
  {
    symbol: "VIRTUAL",
    name: "Virtuals Protocol",
    category: "AI",
    address: "0x44ff8620b8cA30902395A7bD3F2407e1A091BF73",
    explanation:
      "Token of Virtuals Protocol, a platform for deploying and co-owning AI agents — VIRTUAL ERC-20 on Ethereum mainnet (also deployed on Base per project docs).",
  },
  {
    symbol: "MASA",
    name: "Masa Network",
    category: "AI",
    address: "0x944824290CC12F31ae18Ef51216A223Ba4063092",
    explanation:
      "Token of Masa Network, a decentralised data layer for AI training datasets — MASA ERC-20 on Ethereum mainnet (LayerZero OFT).",
  },
  // ── DeFi: oracle / LST / infra — common mis-categorisations ─────────────
  {
    symbol: "LINK",
    name: "Chainlink",
    category: "DeFi",
    address: "0x514910771AF9Ca656af840dff83E8264EcF986CA",
    explanation:
      "LINK powers Chainlink's decentralised oracle network — DeFi infrastructure, NOT AI. Chainlink feeds price data on-chain; it does not run ML models or AI agents.",
  },
  {
    symbol: "RPL",
    name: "Rocket Pool",
    category: "DeFi",
    address: "0xD33526068D116cE69F19A9ee46F0bd304F21A51f",
    explanation:
      "RPL is the governance and insurance collateral token for Rocket Pool, a decentralised ETH liquid staking protocol — DeFi, not L2.",
  },
  {
    symbol: "ENS",
    name: "Ethereum Name Service",
    category: "DeFi",
    address: "0xC18360217D8F7Ab5e7c516566761Ea12Ce7F9D72",
    explanation:
      "ENS governs the Ethereum Name Service on-chain registry — DeFi protocol governance, not L1 or L2.",
  },
  {
    symbol: "BLUR",
    name: "Blur NFT Marketplace",
    category: "DeFi",
    address: "0x5283D291DBCF85356A21bA090E6db59121208b44",
    explanation:
      "BLUR is the governance token of the Blur NFT marketplace and lending protocol — DeFi, not AI.",
  },
  {
    symbol: "ANKR",
    name: "Ankr Network",
    category: "DeFi",
    address: "0x8290333ceF9e6D528dD5618Fb97a76f268f3EDD4",
    explanation:
      "ANKR powers Ankr's decentralised RPC and staking infrastructure — DeFi/infrastructure, NOT an AI protocol. General compute provision ≠ AI/ML models.",
  },
  {
    symbol: "API3",
    name: "API3",
    category: "DeFi",
    address: "0x0b38210ea11411557c13457D4dA7dC6ea731B88a",
    explanation:
      "API3 governs the API3 DAO, a decentralised first-party API oracle protocol — DeFi data-feed infrastructure, not AI.",
  },
  {
    symbol: "BAND",
    name: "Band Protocol",
    category: "DeFi",
    address: "0xBA11D00c5f74255f56a5E366F4F77f5A186d7f55",
    explanation:
      "BAND powers Band Protocol's cross-chain oracle data feeds — DeFi infrastructure, not AI.",
  },
  {
    symbol: "SHIB",
    name: "Shiba Inu",
    category: "DeFi",
    address: "0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE",
    explanation:
      "SHIB is a DeFi meme token on Ethereum with its own ShibaSwap DEX ecosystem — DeFi, not AI or L1.",
  },
  {
    symbol: "PEPE",
    name: "Pepe",
    category: "DeFi",
    address: "0x6982508145454Ce325dDbE47a25d4ec3d2311933",
    explanation:
      "PEPE is a DeFi meme token on Ethereum mainnet — DeFi, not AI, L1, or L2.",
  },
  // ── DeFi: liquid staking tokens (LSTs) — NOT L1 ──────────────────────────
  {
    symbol: "stETH",
    name: "Lido Staked ETH",
    category: "DeFi",
    address: "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84",
    explanation:
      "stETH is Lido's liquid staking receipt token (DeFi), NOT L1. The underlying asset is ETH (L1) but stETH is a DeFi protocol derivative.",
  },
  {
    symbol: "wstETH",
    name: "Lido Wrapped stETH",
    category: "DeFi",
    address: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0",
    explanation:
      "wstETH is the wrapped non-rebasing form of Lido stETH — DeFi, not L1. It wraps staked ETH exposure into a DeFi ERC-20 for composability.",
  },
  {
    symbol: "cbETH",
    name: "Coinbase Wrapped Staked ETH",
    category: "DeFi",
    address: "0xBe9895146f7AF43049ca1c1AE358B0541Ea49704",
    explanation:
      "cbETH is Coinbase's liquid staking ETH derivative — DeFi, not L1. It wraps staked ETH into an ERC-20 for DeFi use; the underlying ETH is L1 but cbETH is not.",
  },
  {
    symbol: "rETH",
    name: "Rocket Pool ETH",
    category: "DeFi",
    address: "0xae78736Cd615f374D3085123A210448E74Fc6393",
    explanation:
      "rETH is Rocket Pool's ETH liquid staking receipt token — DeFi, not L1.",
  },
  // ── L1: streaming / storage blockchains — NOT AI ─────────────────────────
  {
    symbol: "THETA",
    name: "Theta Network",
    category: "L1",
    address: "0x3883f5e181fccaF8410FA61e12b59BAd963fb645",
    explanation:
      "THETA is the native token of Theta Network, an independent L1 blockchain for decentralised video streaming — L1, not AI. Video CDN infrastructure on its own chain does not make it an AI protocol.",
  },
];

/**
 * Hard disambiguation prompts — same scenarios as scripts/check-model.ts `brutal` tests.
 * Single source for training JSONL and post-train VERIFY_QA.
 */
function getBrutalChallenges(): Array<{
  q: string;
  a: string;
  expectedCategory: string;
}> {
  const reg = ETHEREUM_MAINNET_RESEARCHER_TOKEN_REGISTRY;
  const wbtcAddr = MAINNET_TOKENS.WBTC;
  return [
    {
      q:
        "In our taxonomy, what is the difference between L1 and L2 tokens in one sentence, " +
        "then classify OP (Optimism) as exactly one of: L1, L2, Stable, DeFi, RWA, AI.",
      a:
        "L2 — L1 tokens are native assets of independent base-layer blockchains; L2 tokens belong to rollups that scale Ethereum. " +
        "OP is Optimism governance, so it is L2.",
      expectedCategory: "L2",
    },
    {
      q:
        "MATIC on Ethereum mainnet is the legacy Polygon ERC-20. Is it L1, L2, Stable, DeFi, RWA, or AI? " +
        "Answer with exactly one category label.",
      a: "L2 — MATIC on Ethereum is the bridged Polygon ecosystem token representation, classified as Layer 2 in this taxonomy.",
      expectedCategory: "L2",
    },
    {
      q:
        "Someone says USDC is 'DeFi money' because it trades on DEXes. For classification is USDC Stable or DeFi? " +
        "Pick one label only.",
      a: "Stable — USDC is a USD-pegged stablecoin. It is used inside DeFi but the category is Stable, not a protocol governance token.",
      expectedCategory: "Stable",
    },
    {
      q: "DAI is minted by MakerDAO. Is DAI classified as Stable or DeFi in our six-category system? One label only.",
      a: "Stable — DAI is the decentralised USD-pegged stablecoin. MKR is Maker governance (DeFi); DAI itself is Stable.",
      expectedCategory: "Stable",
    },
    {
      q: "WBTC is a wrapped Bitcoin ERC-20 on Ethereum. Classify WBTC: L1, L2, Stable, DeFi, RWA, or AI?",
      a: "L1 — WBTC represents Bitcoin, a Layer 1 asset, on Ethereum via wrapping; in this taxonomy it is grouped with L1 representations.",
      expectedCategory: "L1",
    },
    {
      q: "LINK powers Chainlink oracles. Some confuse it with AI infrastructure. Classify LINK: DeFi or AI? One word label.",
      a: "DeFi — LINK is the token of Chainlink’s decentralised oracle network, a core DeFi infrastructure protocol, not an AI protocol token.",
      expectedCategory: "DeFi",
    },
    {
      q: "LDO is governance for Lido liquid staking. Classify LDO as L2 or DeFi — one label only.",
      a: "DeFi — LDO governs Lido, a liquid staking protocol; it is not an L2 network token.",
      expectedCategory: "DeFi",
    },
    {
      q: "MKR is Maker governance, not the DAI stablecoin itself. Classify MKR: Stable or DeFi?",
      a: "DeFi — MKR is MakerDAO governance. DAI is Stable; MKR is not a stablecoin.",
      expectedCategory: "DeFi",
    },
    {
      q: "PAXG is allocated to physical gold. Is it RWA or L1? One category.",
      a: "RWA — PAXG is gold-backed; it represents a real-world asset on-chain.",
      expectedCategory: "RWA",
    },
    {
      q: "CRVUSD is Curve's USD-pegged stablecoin. Classify: Stable or DeFi?",
      a: "Stable — CRVUSD is a dollar-pegged stablecoin issued by Curve; the stable asset category takes precedence over the issuer being a DeFi protocol.",
      expectedCategory: "Stable",
    },
    {
      q: "FET (Fetch.ai) is used for autonomous agents. Classify: AI or DeFi?",
      a: "AI — FET powers Fetch.ai’s decentralised AI agent network.",
      expectedCategory: "AI",
    },
    {
      q: "Native gas token of Ethereum mainnet (ETH): L1 or L2?",
      a: "L1 — ETH is the native asset of Ethereum, a Layer 1 chain.",
      expectedCategory: "L1",
    },
    {
      q: "UNI is Uniswap DEX governance. Not a stablecoin. One category from our six.",
      a: "DeFi — UNI governs the Uniswap automated market maker protocol.",
      expectedCategory: "DeFi",
    },
    {
      q: `Raw address only, no symbol hint: classify mainnet ${reg["ARB"]!.address}`,
      a: "L2 — This address is Arbitrum’s ARB governance token on Ethereum mainnet, an L2 rollup token.",
      expectedCategory: "L2",
    },
    {
      q: `Contract ${reg["UNI"]!.address} on Ethereum — L1, L2, Stable, DeFi, RWA, or AI?`,
      a: "DeFi — Uniswap (UNI) governance token.",
      expectedCategory: "DeFi",
    },
    {
      q: `What category for ERC-20 at ${wbtcAddr}?`,
      a: "L1 — Wrapped BTC (WBTC), Bitcoin exposure classified as L1 in this taxonomy.",
      expectedCategory: "L1",
    },
    // ── LST / liquid staking (DeFi, not L1 or L2) ───────────────────────────
    {
      q: "stETH is Lido's liquid staking receipt token for ETH. Is stETH L1 or DeFi?",
      a: "DeFi — stETH is a Lido protocol receipt token representing staked ETH. The underlying asset is ETH (L1) but stETH itself is a DeFi derivative issued by a DeFi protocol.",
      expectedCategory: "DeFi",
    },
    {
      q: "stETH is issued by Lido when you stake ETH. Is stETH L2 or DeFi? One label only.",
      a: "DeFi — stETH is a DeFi liquid staking receipt. It is NOT L2: stETH is not a rollup governance token, it is a Lido protocol derivative of staked ETH.",
      expectedCategory: "DeFi",
    },
    {
      q: "wstETH (wrapped stETH) — Stable, L2, or DeFi? What category?",
      a: "DeFi — wstETH is the non-rebasing wrapped form of Lido's stETH. It is a DeFi protocol derivative, not a stablecoin (it tracks ETH price) and not an L2 token.",
      expectedCategory: "DeFi",
    },
    {
      q: "wstETH and cbETH (Coinbase staked ETH) — are these L1, L2, or DeFi?",
      a: "DeFi — both wstETH and cbETH are liquid staking derivatives issued by protocols. They wrap staked ETH exposure but are not native Layer 1 assets nor Layer 2 rollup tokens.",
      expectedCategory: "DeFi",
    },
    {
      q: "Is wstETH a stablecoin? What category is it?",
      a: "DeFi — wstETH is NOT a stablecoin. It tracks the price of staked ETH (volatile) and is a DeFi liquid staking receipt token from Lido. Category: DeFi.",
      expectedCategory: "DeFi",
    },
    {
      q: "cbETH was issued by Coinbase for staked ETH. Category: L1, DeFi, or Stable?",
      a: "DeFi — cbETH is Coinbase's liquid staking ETH derivative. It is a DeFi receipt token (not L1, not a stablecoin — cbETH price fluctuates with ETH).",
      expectedCategory: "DeFi",
    },
    {
      q: "rETH is Rocket Pool's staked ETH receipt token. L1 or DeFi? One label.",
      a: "DeFi — rETH is a DeFi receipt token from Rocket Pool's decentralised staking protocol, not a Layer 1 asset.",
      expectedCategory: "DeFi",
    },
    // ── Oracle tokens (DeFi, not AI) ─────────────────────────────────────────
    {
      q: "LINK (Chainlink) feeds real-world price data to smart contracts. DeFi or AI? One label.",
      a: "DeFi — LINK powers Chainlink's oracle network, classified as DeFi infrastructure. Supplying price data is not the same as running ML models or AI agents.",
      expectedCategory: "DeFi",
    },
    {
      q: "BAND (Band Protocol) is a cross-chain oracle. Classify: DeFi or AI?",
      a: "DeFi — BAND powers Band Protocol's data-feed oracle network — DeFi infrastructure, not an AI protocol.",
      expectedCategory: "DeFi",
    },
    {
      q: "API3 provides first-party oracle APIs to DeFi protocols. DeFi or AI?",
      a: "DeFi — API3 governs a decentralised API oracle DAO, classified as DeFi data-feed infrastructure.",
      expectedCategory: "DeFi",
    },
    // ── L1 streaming/storage chains (NOT AI) ─────────────────────────────────
    {
      q: "THETA is the native token of Theta Network, a blockchain for video streaming. L1 or AI?",
      a: "L1 — THETA is native to Theta Network, an independent Layer 1 blockchain. Video streaming on its own chain does not make it an AI protocol token.",
      expectedCategory: "L1",
    },
    {
      q: "ANKR provides decentralised RPC and cloud-compute infrastructure. DeFi or AI?",
      a: "DeFi — ANKR powers Ankr's staking and RPC protocol. General compute infrastructure provision is not the same as AI/ML model protocols.",
      expectedCategory: "DeFi",
    },
    // ── Meme tokens (DeFi, not L1 or AI) ─────────────────────────────────────
    {
      q: "SHIB is an Ethereum ERC-20 meme token with ShibaSwap DEX. L1, DeFi, or AI?",
      a: "DeFi — SHIB is a DeFi meme token with an on-chain DEX ecosystem. It is an ERC-20 (not a native L1 chain token) and is unrelated to AI.",
      expectedCategory: "DeFi",
    },
    {
      q: "PEPE is an Ethereum ERC-20 meme token. L1 or DeFi? One label.",
      a: "DeFi — PEPE is an ERC-20 on Ethereum mainnet, not a native Layer 1 asset.",
      expectedCategory: "DeFi",
    },
    // ── RPL and ENS disambiguation ────────────────────────────────────────────
    {
      q: "RPL is Rocket Pool's governance token for ETH staking. Is RPL L2 or DeFi? One label.",
      a: "DeFi — RPL governs Rocket Pool's liquid staking DeFi protocol, not a Layer 2 rollup network.",
      expectedCategory: "DeFi",
    },
    {
      q: "ENS governs the Ethereum Name Service on-chain registry. L1, L2, or DeFi?",
      a: "DeFi — ENS is a decentralised protocol governance token. On-chain naming is a DeFi protocol, not a Layer 1 or Layer 2 network.",
      expectedCategory: "DeFi",
    },
    // ── Nuanced stablecoins vs DeFi governance ───────────────────────────────
    {
      q: "FRAX is the USD-pegged stablecoin of Frax Finance (FXS is governance). Classify FRAX: Stable or DeFi?",
      a: "Stable — FRAX is the dollar-pegged stablecoin. FXS (Frax Shares) is the DeFi governance token; FRAX the stablecoin is Stable.",
      expectedCategory: "Stable",
    },
    {
      q: "LUSD is Liquity Protocol's dollar-pegged stablecoin. Stable or DeFi?",
      a: "Stable — LUSD is a USD-pegged stablecoin. LQTY is Liquity governance (DeFi); LUSD itself is Stable.",
      expectedCategory: "Stable",
    },
    {
      q: "USDE is Ethena's synthetic USD stablecoin. Stable or DeFi?",
      a: "Stable — USDE is Ethena's dollar-pegged synthetic stablecoin. ENA (Ethena governance) is DeFi; USDE is Stable.",
      expectedCategory: "Stable",
    },
    // ── GRT: AI not DeFi ─────────────────────────────────────────────────────
    {
      q: "GRT (The Graph) indexes blockchain data for queries. AI or DeFi in our taxonomy?",
      a: "AI — The Graph's decentralised indexing and querying is categorised as AI: it enables machine-readable data pipelines over blockchains, analogous to AI/ML data infrastructure.",
      expectedCategory: "AI",
    },
    // ── Address-only traps without symbol hint ────────────────────────────────
    {
      q: `Classify ${reg["RNDR"]!.address} — AI or DeFi? One label only.`,
      a: "AI — This is RNDR (Render Network), a decentralised GPU compute and AI rendering network.",
      expectedCategory: "AI",
    },
    {
      q: `${reg["MATIC"]!.address} is on Ethereum mainnet. L1 or L2? One label.`,
      a: "L2 — This is MATIC, the legacy Polygon ERC-20 — a Layer 2 ecosystem token.",
      expectedCategory: "L2",
    },
    {
      q: `ERC-20 at ${reg["LDO"]!.address} — DeFi or L2? One label.`,
      a: "DeFi — LDO is Lido's governance token for its liquid staking DeFi protocol.",
      expectedCategory: "DeFi",
    },
  ];
}

// ─── Build JSONL training dataset ────────────────────────────────────────────

function buildDataset(): string {
  const lines: string[] = [];

  for (const t of TOKENS) {
    // Format A: "What type of token is <SYMBOL>?"
    lines.push(
      JSON.stringify({
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `What type of token is ${t.symbol}?` },
          { role: "assistant", content: `${t.category} — ${t.explanation}` },
        ],
      }),
    );
    // Format B: "Classify the token: <Name> (<SYMBOL>)"
    lines.push(
      JSON.stringify({
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: `Classify the token: ${t.name} (${t.symbol})`,
          },
          {
            role: "assistant",
            content: `Category: ${t.category}\n${t.explanation}`,
          },
        ],
      }),
    );
    // Format E: informal single-word / short query
    lines.push(
      JSON.stringify({
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `${t.symbol.toLowerCase()} token category` },
          { role: "assistant", content: `${t.category} — ${t.explanation}` },
        ],
      }),
    );
    // Format F: "is X a Y?" binary challenge (uses the correct category as the label)
    lines.push(
      JSON.stringify({
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: `Is ${t.symbol} an ${t.category} token? Answer with the correct category.`,
          },
          {
            role: "assistant",
            content: `${t.category} — Yes, ${t.symbol} is correctly classified as ${t.category}. ${t.explanation}`,
          },
        ],
      }),
    );
    // Format C: "What token has Ethereum mainnet address 0x...?"
    if (t.address) {
      lines.push(
        JSON.stringify({
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            {
              role: "user",
              content: `What token has Ethereum mainnet address ${t.address}?`,
            },
            {
              role: "assistant",
              content: `${t.symbol} — ${t.name}. Category: ${t.category}. ${t.explanation}`,
            },
          ],
        }),
      );
      // Format D: "Classify the token at Ethereum address 0x..."
      lines.push(
        JSON.stringify({
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            {
              role: "user",
              content: `Classify the token at Ethereum address ${t.address}`,
            },
            {
              role: "assistant",
              content: `Category: ${t.category}\nToken: ${t.name} (${t.symbol})\n${t.explanation}`,
            },
          ],
        }),
      );
    }
  }

  // Extra category-level Q&A examples
  const extras: Array<{ q: string; a: string }> = [
    {
      q: "Which of these is a Layer 1 token: ARB, ETH, or UNI?",
      a: "ETH is the L1 token. ARB is L2 (Arbitrum rollup) and UNI is DeFi (Uniswap governance).",
    },
    {
      q: "Name three L2 tokens and their networks.",
      a: "ARB (Arbitrum), OP (Optimism), POL (Polygon) — Layer 2 scaling ecosystems anchored to Ethereum. MATIC is the legacy Polygon ERC-20 ticker on Ethereum.",
    },
    {
      q: "What distinguishes RWA tokens from DeFi tokens?",
      a: "RWA tokens represent off-chain physical or financial assets (ONDO = US Treasuries, PAXG = gold, CFG = real-world loans). DeFi tokens govern or power on-chain financial protocols like DEXes and lending platforms (UNI, AAVE, CRV).",
    },
    {
      q: "Give four examples of AI tokens and what makes them AI.",
      a: "TAO (Bittensor — decentralised ML training), FET (Fetch.ai — AI agents), RNDR (Render — GPU compute), OCEAN (Ocean Protocol — AI data marketplace). They all power AI/ML infrastructure.",
    },
    {
      q: "Is AVAX an L1 or L2 token?",
      a: "L1. AVAX is the native token of the Avalanche blockchain, an independent Layer 1 network — not a rollup built on top of Ethereum.",
    },
    {
      q: "List one token for each of the six categories.",
      a: "L1: ETH (Ethereum), L2: ARB (Arbitrum), Stable: USDC, DeFi: UNI (Uniswap), RWA: ONDO (Ondo Finance), AI: TAO (Bittensor).",
    },
    {
      q: "Why does the swarm treat USDC differently from UNI for trade planning?",
      a: "USDC is a Stable (USD-pegged) quote token; UNI is DeFi governance. Strategy/Risk agents block trivial stable→stable swaps while allowing volatile↔stable routes.",
    },
    {
      q: "What makes 0G (ZG) an L1 token?",
      a: "ZG is the native token of 0G Network, an independent Layer 1 blockchain purpose-built for decentralised AI infrastructure and storage.",
    },
    {
      q: "Why are PAXG and XAUT classified as RWA tokens?",
      a: "Both tokens are backed by physical gold stored in vaults. Each token represents ownership of a real-world tangible asset, making them Real World Asset (RWA) tokens.",
    },
    {
      q: "How does DeFi differ from AI in token classification?",
      a: "DeFi tokens (UNI, AAVE, GMX) govern on-chain financial protocols like exchanges and lending. AI tokens (FET, TAO, RNDR) power networks focused on machine learning computation, data marketplaces, or autonomous AI agents.",
    },
    {
      q: "Is STRK an L1 or L2 token?",
      a: "L2. STRK is the native token of Starknet, a ZK-STARK rollup that scales Ethereum as a Layer 2.",
    },
    // ── "Fool user" style queries — typos, informal, one-word ──────────────
    {
      q: "arb token?",
      a: "L2 — ARB is the governance token of Arbitrum, an Ethereum Layer 2 optimistic rollup.",
    },
    {
      q: "what is op",
      a: "L2 — OP is the governance token of Optimism, an Ethereum Layer 2 optimistic rollup.",
    },
    {
      q: "matic coin category",
      a: "L2 — MATIC is the legacy Polygon ERC-20 on Ethereum, classified as a Layer 2 ecosystem token.",
    },
    {
      q: "strk token type??",
      a: "L2 — STRK is the native token of Starknet, a ZK-STARK Ethereum Layer 2 rollup.",
    },
    {
      q: "zks zksync what is",
      a: "L2 — ZKS (ZK on-chain) is the governance token of ZKsync, an Ethereum Layer 2 ZK-rollup.",
    },
    {
      q: "pol polygon new token classify pls",
      a: "L2 — POL is the Polygon Ecosystem Token, the MATIC successor used for Polygon PoS staking — classified as L2.",
    },
    {
      q: "imx immutable",
      a: "L2 — IMX is the native token of Immutable X, an Ethereum Layer 2 for NFTs using ZK proofs.",
    },
    {
      q: "eth coin type",
      a: "L1 — ETH is the native token of Ethereum, the leading Layer 1 smart-contract blockchain.",
    },
    {
      q: "btc category?",
      a: "L1 — BTC is the native token of Bitcoin, the original Layer 1 proof-of-work blockchain. On Ethereum mainnet, WBTC is the ERC-20 representation — still classified as L1.",
    },
    {
      q: "usdc type",
      a: "Stable — USDC is a USD-pegged stablecoin on Ethereum mainnet (ERC-20), used as quote liquidity.",
    },
    {
      q: "aave what kind",
      a: "DeFi — AAVE is the governance token of Aave, a leading decentralised lending and borrowing protocol.",
    },
    {
      q: "fet ai?",
      a: "AI — FET is the token of Fetch.ai, a decentralised machine-learning network powering autonomous AI agents.",
    },
    {
      q: "rndr render token classify",
      a: "AI — RNDR is the token of Render Network, a decentralised GPU compute and AI rendering network.",
    },
    {
      q: "ondo finance rwa?",
      a: "RWA — ONDO is the token of Ondo Finance, which issues tokenised US Treasuries and other real-world assets.",
    },
    {
      q: "arbiturm token",
      a: "L2 — That is ARB, the governance token of Arbitrum (you may have a typo). Arbitrum is an Ethereum Layer 2 optimistic rollup.",
    },
    {
      q: "optmism coin",
      a: "L2 — That is OP, the governance token of Optimism (possible typo for 'Optimism'). Optimism is an Ethereum Layer 2 rollup.",
    },
    {
      q: "steth defi or l2?",
      a: "DeFi — stETH is Lido's liquid staking receipt token. It is a DeFi derivative of staked ETH, NOT an L2 token. L2 tokens are rollup governance/utility tokens like ARB or OP.",
    },
    {
      q: "wsteth stable?",
      a: "DeFi — wstETH is NOT a stablecoin. It is the wrapped non-rebasing form of Lido stETH, a DeFi liquid staking receipt whose value tracks ETH.",
    },
    {
      q: "ldo l2 or defi",
      a: "DeFi — LDO is the governance token of Lido, a liquid staking DeFi protocol. It is not a Layer 2 rollup token.",
    },
    {
      q: "rpl rocket pool layer 2?",
      a: "DeFi — RPL governs Rocket Pool, a decentralised ETH staking DeFi protocol. It is NOT an L2 network token.",
    },
    {
      q: "sol token l1 or l2",
      a: "L1 — SOL is the native token of Solana, an independent Layer 1 blockchain, not a rollup.",
    },
    {
      q: "link oracle ai?",
      a: "DeFi — LINK powers Chainlink's oracle network. It is DeFi infrastructure; providing price data is not the same as running AI/ML models.",
    },
    {
      q: "paxg gold token what is",
      a: "RWA — PAXG (PAX Gold) is backed by physical gold in a vault. Each token represents one troy ounce of real-world gold — category RWA.",
    },
    {
      q: "wbtc l1 or defi?",
      a: "L1 — WBTC (Wrapped Bitcoin) is the ERC-20 representation of Bitcoin on Ethereum. In our taxonomy it is classified as L1 because it represents Bitcoin, a Layer 1 asset.",
    },
    {
      q: "dai stablecoin or defi",
      a: "Stable — DAI is a USD-pegged stablecoin minted by MakerDAO. MKR is DeFi governance; DAI itself is a Stable.",
    },
    {
      q: "scroll l2?",
      a: "L2 — Scroll (SCR) is an Ethereum Layer 2 ZK-EVM rollup. Its native token is classified as L2.",
    },
    {
      q: "blast token type",
      a: "L2 — BLAST is the native token of Blast, an Ethereum Layer 2 with built-in native yield for ETH and stablecoins.",
    },
    {
      q: "manta l2",
      a: "L2 — MANTA is the native token of Manta Pacific, an Ethereum Layer 2 ZK network for modular DeFi.",
    },
    {
      q: "metis rollup token",
      a: "L2 — METIS is the native token of Metis, an Ethereum Layer 2 optimistic rollup.",
    },
    {
      q: "boba token l2?",
      a: "L2 — BOBA is the governance token of Boba Network, an Ethereum Layer 2 optimistic rollup.",
    },
    {
      q: "tao ai or l1",
      a: "AI — TAO is the native token of Bittensor, a decentralised network that incentivises AI model training. It is an AI protocol token.",
    },
    {
      q: "virtual protocol ai token?",
      a: "AI — VIRTUAL is the token of Virtuals Protocol, a platform for deploying and co-owning AI agents. Category: AI.",
    },
    // ── Goal → token selection (research agent routing) ────────────────────
    {
      q: "I want to research L2 tokens. From this list: ARB, FET, UNI, OP, AAVE, STRK, ZKS, POL. Which are L2?",
      a: "ARB (Arbitrum), OP (Optimism), STRK (Starknet), ZKS (zkSync), POL (Polygon) are L2 tokens. FET is AI, UNI is DeFi, AAVE is DeFi.",
    },
    {
      q: "Goal: AI crypto tokens. Pick from: FET, ARB, TAO, UNI, RNDR, OCEAN, AAVE, AGIX, GRT.",
      a: "FET, TAO, RNDR, OCEAN, AGIX, GRT are AI tokens. ARB is L2, UNI and AAVE are DeFi.",
    },
    {
      q: "Find me DeFi tokens from: UNI, ARB, AAVE, FET, CRV, MKR, STRK, LDO.",
      a: "UNI, AAVE, CRV, MKR, LDO are DeFi tokens. ARB and STRK are L2, FET is AI.",
    },
    {
      q: "Staking tokens — which are they: LDO, ARB, RPL, FET, stETH, rETH, OP?",
      a: "LDO, RPL, stETH, rETH are liquid staking / staking DeFi tokens. ARB and OP are L2, FET is AI.",
    },
    {
      q: "Safe haven tokens for a market crash, pick from: WBTC, ARB, WETH, FET, UNI.",
      a: "WBTC and WETH are the safe-haven tokens — they represent Bitcoin and Ethereum, the most liquid and established assets. ARB is L2, FET is AI, UNI is DeFi.",
    },
    {
      q: "layer 2 rollup coins arbiturm optimsim matic — what tokens to research?",
      a: "ARB (Arbitrum), OP (Optimism), MATIC (Polygon legacy), POL (Polygon Ecosystem Token), STRK (Starknet), ZKS (zkSync) are the core L2 tokens to research. These are all L2 rollup ecosystem tokens.",
    },
    {
      q: "find good ai crypto tokens to buy",
      a: "For AI-focused research: TAO (Bittensor — ML training incentives), FET (Fetch.ai — AI agents), RNDR (Render — GPU compute), GRT (The Graph — blockchain indexing), OCEAN (Ocean Protocol — AI data marketplace), AGIX (SingularityNET — AI algorithm marketplace). All classified as AI.",
    },
    {
      q: "defi protocols yield farming which tokens",
      a: "For DeFi/yield research: UNI (Uniswap DEX), AAVE (lending), CRV (Curve stable swaps), MKR (MakerDAO), COMP (Compound), BAL (Balancer). All DeFi governance tokens.",
    },
    {
      q: "give me the ethereum addresses for the top L2 tokens",
      a: "ARB: 0xB50721BCf8d664c30412Cfbc6cf7a15145234ad1 | POL: 0x455e53CBB86018Ac2B8092FdCd39d8444aFFC3F6 | MATIC: 0x7D1AfA7B718fb893dB30A3aBc0Cfc608AaCfeBB0 | STRK: 0xCa14007Eff0dB1f8135f4C25B34De49AB0d42766 | IMX: 0xF57e7e7C23978C3cAEC3C3548E3D615c346e79fF | ZKS: 0x66A5cFB2e9c529f14FE6364Ad1075dF3a649C0A5 | BOBA: 0x42bBFa2e77757C645eeaAd1655E0911a7553Efbc | METIS: 0x9E32b13ce7f2E80A01932B42553652E053D6ed8e | MANTA: 0xa7ba16B12A5b068CB0Af480db33Ee68D13819AFA",
    },
    {
      q: "ethereum addresses for AI tokens: FET, TAO, RNDR, OCEAN, AGIX",
      a: "FET: 0xaea46A60368A7bD060eec7DF8CBa43b7EF41Ad85 | TAO (wTAO): 0x77E06c9eCCf2E797fd462A92B6D7642EF85b0A44 | RNDR: 0x6De037ef9aD2725EB40118Bb1702EBb27e4Aeb24 | OCEAN: 0x967da4048cD07aB37855c090aAF366e4ce1b9F48 | AGIX: 0x5B7533812759B45C2B44C19e320ba2cD2681b542",
    },
    {
      q: "what is the contract address of ARB on ethereum mainnet?",
      a: "ARB (Arbitrum) on Ethereum mainnet: 0xB50721BCf8d664c30412Cfbc6cf7a15145234ad1",
    },
    {
      q: "TAO bittensor mainnet address?",
      a: "TAO (Wrapped TAO / wTAO) on Ethereum mainnet: 0x77E06c9eCCf2E797fd462A92B6D7642EF85b0A44",
    },
    {
      q: "FET fetch ai contract address ethereum",
      a: "FET (Fetch.ai) on Ethereum mainnet: 0xaea46A60368A7bD060eec7DF8CBa43b7EF41Ad85",
    },
  ];

  for (const e of [...extras, ...getBrutalChallenges()]) {
    lines.push(
      JSON.stringify({
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: e.q },
          { role: "assistant", content: e.a },
        ],
      }),
    );
  }

  return lines.join("\n");
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function ensureDir(p: string): void {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

// ─── On-chain address verification (pre-training integrity check) ─────────────
// Calls symbol() on every token address via the Ethereum RPC. Mismatches or
// call failures are printed as warnings but never block training.

const ERC20_SYMBOL_ABI = ["function symbol() external view returns (string)"];

// Known on-chain symbol ≠ dataset symbol pairs (bridged / wrapped conventions)
const SYMBOL_ALIASES: Record<string, string> = {
  BTC: "WBTC", // WBTC contract, dataset uses "BTC"
  ZKS: "ZK", // zkSync on-chain ticker is "ZK"
  WETH: "WETH", // always matches
};

async function onChainVerifyAddresses(): Promise<void> {
  const rpcUrl = process.env["ETH_RPC_URL"] ?? "https://eth.llamarpc.com";
  const provider = new ethers.JsonRpcProvider(rpcUrl, 1, {
    staticNetwork: true,
  });

  console.log("\n🔍  Pre-training on-chain address verification…");
  console.log(`   RPC: ${rpcUrl}\n`);

  // Skip the ETH placeholder — it is not a real contract.
  const toCheck = TOKENS.filter(
    (t) =>
      t.address && t.address !== "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
  );

  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  // Batch requests but cap concurrency to avoid rate-limiting the public RPC.
  const CONCURRENCY = 5;
  for (let i = 0; i < toCheck.length; i += CONCURRENCY) {
    const batch = toCheck.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (t) => {
        if (!t.address) return;
        try {
          const contract = new ethers.Contract(
            t.address,
            ERC20_SYMBOL_ABI,
            provider,
          );
          const onChain = ((await contract.symbol()) as string).trim();
          const expected = SYMBOL_ALIASES[t.symbol] ?? t.symbol;
          if (onChain.toUpperCase() === expected.toUpperCase()) {
            passed++;
            console.log(
              `   ✅  ${t.symbol.padEnd(8)} @ ${t.address.slice(0, 10)}…  → "${onChain}"`,
            );
          } else {
            // Still useful data even if symbol differs (e.g. stETH has non-standard symbol)
            console.log(
              `   ⚠️  ${t.symbol.padEnd(8)} @ ${t.address.slice(0, 10)}…  → on-chain="${onChain}" (expected "${expected}") — verify manually`,
            );
            failures.push(
              `${t.symbol} @ ${t.address}: expected "${expected}", got "${onChain}"`,
            );
            failed++;
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // RPC error / non-ERC20 contract — warn and continue
          console.log(
            `   ⚠️  ${t.symbol.padEnd(8)} @ ${t.address!.slice(0, 10)}…  → RPC error: ${msg.slice(0, 70)}`,
          );
        }
      }),
    );
  }

  console.log(
    `\n   Result: ${passed} matched, ${failed} mismatched out of ${toCheck.length} addresses.`,
  );
  if (failures.length > 0) {
    console.warn(
      "\n   Address mismatches — training will continue but verify these entries:",
    );
    failures.forEach((f) => console.warn(`     • ${f}`));
    console.warn();
  } else {
    console.log(
      "   ✅  All checked addresses returned matching on-chain symbols.\n",
    );
  }
}

// ─── Inference verification ───────────────────────────────────────────────────

const VERIFY_QA: Array<{ q: string; expectedCategory: string }> = [
  { q: "What type of token is ETH?", expectedCategory: "L1" },
  { q: "What type of token is WETH?", expectedCategory: "L1" },
  { q: "What type of token is BTC?", expectedCategory: "L1" },
  { q: "What type of token is ARB?", expectedCategory: "L2" },
  { q: "What type of token is MATIC?", expectedCategory: "L2" },
  { q: "What type of token is POL?", expectedCategory: "L2" },
  { q: "What type of token is USDC?", expectedCategory: "Stable" },
  { q: "What type of token is DAI?", expectedCategory: "Stable" },
  { q: "What type of token is UNI?", expectedCategory: "DeFi" },
  { q: "What type of token is AAVE?", expectedCategory: "DeFi" },
  { q: "What type of token is ONDO?", expectedCategory: "RWA" },
  { q: "What type of token is PAXG?", expectedCategory: "RWA" },
  { q: "What type of token is TAO?", expectedCategory: "AI" },
  { q: "What type of token is RNDR?", expectedCategory: "AI" },
  { q: "Classify the token: Solana (SOL)", expectedCategory: "L1" },
  { q: "Classify the token: Optimism (OP)", expectedCategory: "L2" },
  { q: "Classify the token: Curve Finance (CRV)", expectedCategory: "DeFi" },
  { q: "Classify the token: Centrifuge (CFG)", expectedCategory: "RWA" },
  { q: "Classify the token: Ocean Protocol (OCEAN)", expectedCategory: "AI" },
  // Address-based verification
  {
    q: "What token has Ethereum mainnet address 0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984?",
    expectedCategory: "DeFi",
  },
  {
    q: "Classify the token at Ethereum address 0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9",
    expectedCategory: "DeFi",
  },
  {
    q: "What token has Ethereum mainnet address 0x7D1AfA7B718fb893dB30A3aBc0Cfc608AaCfeBB0?",
    expectedCategory: "L2",
  },
  {
    q: "Classify the token at Ethereum address 0x45804880De22913dAFE09f4980848ECE6EcbAf78",
    expectedCategory: "RWA",
  },
  {
    q: "What token has Ethereum mainnet address 0x6De037ef9aD2725EB40118Bb1702EBb27e4Aeb24?",
    expectedCategory: "AI",
  },
  {
    q: "Classify the token at Ethereum address 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    expectedCategory: "L1",
  },
  {
    q: "What token has Ethereum mainnet address 0x455e53CBB86018Ac2B8092FdCd39d8444aFFC3F6?",
    expectedCategory: "L2",
  },
  {
    q: "What token has Ethereum mainnet address 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48?",
    expectedCategory: "Stable",
  },
  {
    q: "Classify the token at Ethereum address 0x6B175474E89094C44Da98b954EedeAC495271d0F",
    expectedCategory: "Stable",
  },
  {
    q: "Classify the token at Ethereum address 0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
    expectedCategory: "L1",
  },
  {
    q: "What token has Ethereum mainnet address 0xCa14007Eff0dB1f8135f4C25B34De49AB0d42766?",
    expectedCategory: "L2",
  },
  // ── New tokens: LSTs, oracles, memes, L1s ────────────────────────────────
  { q: "What type of token is LINK?", expectedCategory: "DeFi" },
  { q: "What type of token is stETH?", expectedCategory: "DeFi" },
  { q: "What type of token is wstETH?", expectedCategory: "DeFi" },
  { q: "What type of token is cbETH?", expectedCategory: "DeFi" },
  { q: "What type of token is rETH?", expectedCategory: "DeFi" },
  { q: "What type of token is RPL?", expectedCategory: "DeFi" },
  { q: "What type of token is THETA?", expectedCategory: "L1" },
  { q: "What type of token is SHIB?", expectedCategory: "DeFi" },
  { q: "What type of token is PEPE?", expectedCategory: "DeFi" },
  { q: "What type of token is ANKR?", expectedCategory: "DeFi" },
  {
    q: "Classify the token at Ethereum address 0x514910771AF9Ca656af840dff83E8264EcF986CA",
    expectedCategory: "DeFi",
  },
  {
    q: "What token has Ethereum mainnet address 0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84?",
    expectedCategory: "DeFi",
  },
  {
    q: "Classify the token at Ethereum address 0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0",
    expectedCategory: "DeFi",
  },
  {
    q: "What token has Ethereum mainnet address 0xae78736Cd615f374D3085123A210448E74Fc6393?",
    expectedCategory: "DeFi",
  },
  {
    q: "Classify the token at Ethereum address 0x3883f5e181fccaF8410FA61e12b59BAd963fb645",
    expectedCategory: "L1",
  },
  {
    q: "What token has Ethereum mainnet address 0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE?",
    expectedCategory: "DeFi",
  },
  {
    q: "Classify the token at Ethereum address 0x6982508145454Ce325dDbE47a25d4ec3d2311933",
    expectedCategory: "DeFi",
  },
  // Brutal / disambiguation (same prompts as getBrutalChallenges — keep in sync with scripts/check-model.ts)
  ...getBrutalChallenges().map(({ q, expectedCategory }) => ({
    q,
    expectedCategory,
  })),
];

async function runInferenceVerification(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  broker: any,
  providerAddr: string,
): Promise<void> {
  console.log("\n" + "─".repeat(62));
  console.log("🔬  POST-TRAINING INFERENCE VERIFICATION");
  console.log("─".repeat(62));

  // List inference services
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let inferenceServices: any[] = [];
  try {
    inferenceServices =
      (await broker.inference.listService()) as typeof inferenceServices;
    console.log(
      `   Found ${inferenceServices.length} inference service(s) on 0G network.`,
    );
  } catch (err) {
    console.warn(
      `   ⚠️  Could not list inference services: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  if (inferenceServices.length === 0) {
    console.warn(
      "   ⚠️  No inference services available yet — skipping live verification.",
    );
    return;
  }

  // Prefer same provider as fine-tuning, fall back to any chatbot, then first service
  const svc = (inferenceServices.find(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (s: any) =>
      (s.provider as string)?.toLowerCase() === providerAddr.toLowerCase(),
  ) ??
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    inferenceServices.find(
      (s: any) => (s.serviceType as string) === "chatbot",
    ) ??
    inferenceServices[0]) as {
    provider: string;
    model?: string;
    url?: string;
    endpoint?: string;
  };

  const displayProvider = svc.provider.slice(0, 12) + "…";
  console.log(
    `   Provider  : ${displayProvider}  model: ${svc.model ?? "(auto)"}`,
  );

  // Acknowledge provider signer (non-fatal)
  try {
    await (
      broker.inference.acknowledgeProviderSigner(
        svc.provider,
      ) as Promise<unknown>
    ).catch(() => null);
  } catch {
    /* non-fatal */
  }

  // Resolve endpoint
  let endpoint = svc.url ?? svc.endpoint ?? "";
  try {
    const meta = (await broker.inference.getServiceMetadata(svc.provider)) as {
      endpoint?: string;
      model?: string;
    };
    endpoint = meta.endpoint ?? endpoint;
  } catch {
    /* non-fatal */
  }

  if (!endpoint) {
    console.warn(
      "   ⚠️  Could not resolve inference endpoint — skipping live verification.",
    );
    return;
  }

  // Get signed auth headers
  let headers: Record<string, string> = {};
  try {
    headers = (await broker.inference.getRequestHeaders(
      svc.provider,
    )) as Record<string, string>;
  } catch (err) {
    console.warn(
      `   ⚠️  getRequestHeaders failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  console.log(`   Endpoint  : ${endpoint}`);
  console.log(`\n   Running ${VERIFY_QA.length} verification prompts…\n`);

  let passed = 0;
  let failed = 0;

  for (const { q, expectedCategory } of VERIFY_QA) {
    const body = JSON.stringify({
      model: svc.model ?? MODEL_NAME,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: q },
      ],
      max_tokens: 120,
      temperature: 0.1,
    });

    // Respect the 10 req/min rate limit (6s gap between requests).
    await sleep(6_500);

    try {
      const res = await fetch(`${endpoint}/chat/completions`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body,
      });

      if (!res.ok) {
        const text = await res.text();
        // Retry once after 65s on 429
        if (res.status === 429) {
          console.log(`   ⏳  Rate limited — waiting 65s before retry…`);
          await sleep(65_000);
          const retry = await fetch(`${endpoint}/chat/completions`, {
            method: "POST",
            headers: { ...headers, "Content-Type": "application/json" },
            body,
          });
          if (retry.ok) {
            const json = (await retry.json()) as {
              choices: Array<{ message: { content: string } }>;
            };
            const answer = (json.choices[0]?.message?.content ?? "").trim();
            const isCorrect = answer
              .toUpperCase()
              .includes(expectedCategory.toUpperCase());
            if (isCorrect) {
              console.log(
                `   ✅  [PASS] ${expectedCategory.padEnd(4)} | "${q}"`,
              );
              console.log(`             → ${answer.slice(0, 110)}`);
              passed++;
            } else {
              console.log(
                `   ❌  [FAIL] ${expectedCategory.padEnd(4)} | "${q}"`,
              );
              console.log(
                `             Expected: ${expectedCategory}  Got: ${answer.slice(0, 110)}`,
              );
              failed++;
            }
            continue;
          }
        }
        console.log(`   ❌  [FAIL] "${q}"`);
        console.log(`        HTTP ${res.status}: ${text.slice(0, 120)}`);
        failed++;
        continue;
      }

      const json = (await res.json()) as {
        choices: Array<{ message: { content: string } }>;
      };
      const answer = (json.choices[0]?.message?.content ?? "").trim();
      const isCorrect = answer
        .toUpperCase()
        .includes(expectedCategory.toUpperCase());

      if (isCorrect) {
        console.log(`   ✅  [PASS] ${expectedCategory.padEnd(4)} | "${q}"`);
        console.log(`             → ${answer.slice(0, 110)}`);
        passed++;
      } else {
        console.log(`   ❌  [FAIL] ${expectedCategory.padEnd(4)} | "${q}"`);
        console.log(`             Expected category: ${expectedCategory}`);
        console.log(`             Got: ${answer.slice(0, 110)}`);
        failed++;
      }
    } catch (err) {
      console.log(
        `   ⚠️  [ERR]  "${q}": ${err instanceof Error ? err.message : String(err)}`,
      );
      failed++;
    }
  }

  const total = passed + failed;
  const pct = total > 0 ? ((passed / total) * 100).toFixed(0) : "0";

  console.log("\n" + "─".repeat(62));
  console.log(
    `📊  Verification result : ${passed}/${total} correct  (${pct}%)`,
  );
  if (passed === total) {
    console.log(
      "🏆  Perfect score — model is classifying all token types correctly!",
    );
  } else if (passed >= Math.ceil(total * 0.7)) {
    console.log(
      "✅  Model is working well (≥70% accuracy on verification prompts).",
    );
  } else {
    console.log(
      "⚠️  Accuracy is low — consider increasing epochs or adding more examples.",
    );
  }
  console.log("─".repeat(62) + "\n");
}

// ─── Pipeline step functions ──────────────────────────────────────────────────

interface BrokerCtx {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  broker: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ft: any;
  wallet: ethers.Wallet;
  rpcUrl: string;
}

async function connectBroker(): Promise<BrokerCtx> {
  const rpcUrl = process.env["ZG_CHAIN_RPC"] ?? "https://evmrpc-testnet.0g.ai";
  const privateKey = extractPrivateKey(process.env["ZG_PRIVATE_KEY"] ?? "");
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);

  console.log("\n⏳  Connecting to 0G Compute Network broker…");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const broker = (await createZGComputeNetworkBroker(wallet)) as any;

  if (!broker.fineTuning) {
    throw new Error("FineTuning module is not available on this contract.");
  }
  return { broker, ft: broker.fineTuning, wallet, rpcUrl };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function selectProvider(ft: any): Promise<string> {
  console.log("🔍  Listing fine-tuning services…");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const services: any[] = await ft.listService();
  if (services.length === 0)
    throw new Error("No fine-tuning services found on the 0G testnet.");

  console.log(`   Found ${services.length} service(s):`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  services.forEach((s: any, i: number) => {
    console.log(
      `   [${i}] provider=${s.provider}  model=${s.model ?? "(any)"}`,
    );
  });

  if (PROVIDER_ADDR) {
    console.log(`\n   Using specified provider : ${PROVIDER_ADDR}`);
    return PROVIDER_ADDR;
  }
  const chosen = services[0].provider as string;
  console.log(`\n   Auto-selected provider   : ${chosen}`);
  return chosen;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function ensureLedgerFunded(
  broker: any,
  providerAddr: string,
): Promise<void> {
  console.log("\n💰  Setting up compute ledger & fine-tuning sub-account…");
  try {
    const ledger = await broker.ledger.getLedger();
    const balOG = (Number(ledger.totalBalance) / 1e18).toFixed(4);
    console.log(`   ℹ️   Ledger exists, total balance: ${balOG} OG`);
  } catch {
    console.log("   📝  No ledger found — creating with 3 OG…");
    await broker.ledger.addLedger(3);
    console.log("   ✅  Ledger created (3 OG deposited).");
  }
  // Transfer 1 OG to the provider's fine-tuning sub-account (creates it if it doesn't exist).
  // Without this, acknowledgeProviderSigner silently fails and TEE upload returns 401.
  try {
    await broker.ledger.transferFund(
      providerAddr,
      "fine-tuning",
      BigInt(1) * BigInt(10 ** 18),
    );
    console.log(
      "   ✅  Fine-tuning sub-account funded (1 OG transferred to provider).",
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // InsufficientAvailableBalance means it's already topped-up — safe to continue.
    console.warn(`   ⚠️  transferFund: ${msg}`);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function acknowledgeProvider(
  ft: any,
  providerAddr: string,
): Promise<void> {
  console.log("\n🤝  Acknowledging provider TEE signer…");
  try {
    await ft.acknowledgeProviderSigner(providerAddr);
    console.log("   ✅  TEE signer acknowledged.");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/already acknowledged|already registered/i.test(msg)) {
      console.log("   ℹ️   Already acknowledged.");
    } else {
      throw new Error(`acknowledgeProviderSigner failed: ${msg}`);
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function uploadDataset(
  ft: any,
  providerAddr: string,
  datasetPath: string,
): Promise<string> {
  if (UPLOAD_METHOD === "tee") {
    console.log("\n📤  Uploading dataset to TEE…");
    const result = (await ft.uploadDatasetToTEE(providerAddr, datasetPath)) as {
      datasetHash: string;
      message: string;
    };
    console.log(`   ✅  Dataset hash : ${result.datasetHash}`);
    console.log(`   ℹ️   ${result.message}`);
    return result.datasetHash;
  }
  console.log("\n📤  Uploading dataset to 0G Storage…");
  const hash = (await ft.uploadDataset(datasetPath)) as string;
  console.log(`   ✅  Dataset hash : ${hash}`);
  return hash;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function submitTask(
  ft: any,
  providerAddr: string,
  datasetHash: string,
  tmpDir: string,
): Promise<string> {
  // The SDK reads the 4th arg as a file path to a JSON training-params file.
  const trainingParamsFile = path.join(tmpDir, "training-params.json");
  fs.writeFileSync(
    trainingParamsFile,
    JSON.stringify(TRAINING_PARAMS, null, 2),
    "utf-8",
  );
  const loraOutputPath = path.resolve(OUTPUT_DIR);

  console.log("\n🚀  Submitting training task…");
  console.log(`   model          : ${MODEL_NAME}`);
  console.log(`   dataset hash   : ${datasetHash}`);
  console.log(`   training params: ${JSON.stringify(TRAINING_PARAMS)}`);

  // ── Pre-flight: list tasks and clear any that block new task creation ───────
  // The provider enforces one active task per user.  createTask fails with
  // "cannot create a new task while there is an unfinished task" if ANY prior
  // task is not in a fully acknowledged terminal state.
  //
  // "Delivered"  = training done, LoRA ready, but acknowledgeDeliverable NOT yet
  //                called on-chain.  Provider blocks new tasks until ack'd.
  // "Finished" / "Succeeded" / "Completed" / "Done"
  //              = task was already acknowledged on-chain. Provider no longer
  //                blocks new task creation. Treat as terminal.
  // "Failed" / "Cancelled" / "Error"
  //              = terminal error states — no action needed.
  const PROVIDER_TERMINAL_STATES = new Set([
    "failed",
    "cancelled",
    "canceled",
    "error",
    // Post-acknowledgement states — task slot is free:
    "finished",
    "succeeded",
    "completed",
    "done",
  ]);

  // Tasks that were already-settled on-chain (CannotAcknowledgeSettledDeliverable)
  // are de-facto cleared — track them so the sync poll doesn't wait for them.
  const alreadySettledIds = new Set<string>();

  let existingTasks: any[] = [];
  try {
    existingTasks = (await ft.listTask(providerAddr)) ?? [];
    if (existingTasks.length > 0) {
      console.log(
        `   Found ${existingTasks.length} existing task(s) on provider:`,
      );
      for (const t of existingTasks) {
        console.log(
          `     • id=${t.id ?? "?"} progress="${t.progress ?? ""}" deliverIndex="${t.deliverIndex ?? ""}"`,
        );
      }
    }
  } catch (listErr) {
    console.warn(
      `   ⚠️  listTask failed (will still attempt createTask): ${listErr instanceof Error ? listErr.message : String(listErr)}`,
    );
  }

  // A task is blocking if it has an id and is not in a known provider-terminal state.
  const blockingTasks = existingTasks.filter((t: any) => {
    if (!t.id) return false;
    const prog = ((t.progress as string | undefined) ?? "")
      .toLowerCase()
      .trim();
    return !PROVIDER_TERMINAL_STATES.has(prog);
  });

  if (blockingTasks.length > 0) {
    console.log(
      `\n⚠️   ${blockingTasks.length} blocking task(s) detected — clearing before submitting new task…`,
    );
    for (const t of blockingTasks) {
      const tid = t.id as string;
      const prog = ((t.progress as string | undefined) ?? "")
        .toLowerCase()
        .trim();
      const isDelivered = [
        "delivered",
        "succeeded",
        "finished",
        "completed",
        "done",
      ].includes(prog);

      if (isDelivered) {
        // Training already finished — the model is ready on the TEE.
        // We MUST call acknowledgeModel (which calls acknowledgeDeliverable on-chain)
        // to clear the slot.  The TEE may 429-throttle the LoRA download, so retry
        // with backoff.  cancelTask returns HTTP 400 on Delivered tasks — do NOT try it.
        const MAX_ACK_ATTEMPTS = 5;
        const ACK_RETRY_DELAY_MS = 40_000; // 40 s between retries
        let ackOk = false;
        for (let attempt = 1; attempt <= MAX_ACK_ATTEMPTS; attempt++) {
          try {
            console.log(
              `   ℹ️   Task ${tid} is "${t.progress}" — acknowledging to clear slot (attempt ${attempt}/${MAX_ACK_ATTEMPTS})…`,
            );
            await ft.acknowledgeModel(providerAddr, tid, loraOutputPath, {
              downloadMethod: "tee",
            });
            console.log(
              `   ✅  Acknowledged task ${tid} — LoRA saved to ${loraOutputPath}`,
            );
            console.log(
              `       (Previous trained model preserved. Retraining now with updated dataset.)`,
            );
            ackOk = true;
            break;
          } catch (ackErr) {
            const msg =
              ackErr instanceof Error ? ackErr.message : String(ackErr);
            // Already settled on-chain — slot is free, proceed as if acknowledged.
            const alreadySettled = msg.includes(
              "CannotAcknowledgeSettledDeliverable",
            );
            if (alreadySettled) {
              console.log(
                `   ✅  Task ${tid} is already settled on-chain — slot is free, proceeding.`,
              );
              alreadySettledIds.add(tid);
              ackOk = true;
              break;
            }
            const is429 =
              msg.includes("429") ||
              msg.toLowerCase().includes("too many requests");
            if (is429 && attempt < MAX_ACK_ATTEMPTS) {
              console.warn(
                `   ⚠️  TEE rate-limited (429) — waiting ${ACK_RETRY_DELAY_MS / 1000}s before retry ${attempt + 1}/${MAX_ACK_ATTEMPTS}…`,
              );
              await new Promise<void>((r) => setTimeout(r, ACK_RETRY_DELAY_MS));
            } else {
              console.warn(
                `   ⚠️  acknowledgeModel failed (attempt ${attempt}/${MAX_ACK_ATTEMPTS}): ${msg}`,
              );
              if (attempt === MAX_ACK_ATTEMPTS) {
                throw new Error(
                  `Cannot clear the blocking "Delivered" task ${tid} after ${MAX_ACK_ATTEMPTS} attempts.\n` +
                    `  The TEE is rate-limiting LoRA downloads. Wait a few minutes then retry:\n` +
                    `  pnpm run train-model`,
                );
              }
            }
          }
        }
        if (!ackOk) {
          // Should be unreachable (the throw above fires first), but guard anyway.
          throw new Error(
            `Failed to acknowledge task ${tid}. Run pnpm run train-model again in a few minutes.`,
          );
        }
      } else {
        // Still running / pending — cancel it.
        try {
          await ft.cancelTask(providerAddr, tid);
          console.log(
            `   ✅  Cancelled task ${tid}  (progress was: "${t.progress ?? ""}")`,
          );
        } catch (cancelErr) {
          console.warn(
            `   ⚠️  Could not cancel task ${tid}: ${cancelErr instanceof Error ? cancelErr.message : String(cancelErr)}`,
          );
          console.warn(
            `       To resume that task: pnpm run train-model -- --skip-train --task-id ${tid}`,
          );
        }
      }
    }
    // Poll listTask until all previously-blocking tasks have left the provider's
    // active list. This ensures the provider's backend has indexed the on-chain
    // acknowledgeDeliverable tx before we attempt createTask.
    const SYNC_TIMEOUT_MS = 180_000; // 3 minutes max
    const SYNC_POLL_MS = 8_000; // poll every 8 s
    const clearedIds = new Set(blockingTasks.map((t: any) => t.id as string));
    console.log(`   ⏳  Waiting for provider to sync acknowledged task(s)…`);
    const syncStart = Date.now();
    while (Date.now() - syncStart < SYNC_TIMEOUT_MS) {
      await new Promise<void>((r) => setTimeout(r, SYNC_POLL_MS));
      const remaining: any[] = (await ft.listTask(providerAddr)) ?? [];
      const stillBlocking = remaining.filter((t: any) => {
        if (!t.id || !clearedIds.has(t.id as string)) return false;
        if (alreadySettledIds.has(t.id as string)) return false; // already settled on-chain
        const prog = (t.progress ?? "").toLowerCase().trim();
        return !PROVIDER_TERMINAL_STATES.has(prog);
      });
      if (stillBlocking.length === 0) {
        console.log(
          `   ✅  Provider task list is clear — proceeding to create new task.`,
        );
        break;
      }
      const elapsedS = Math.round((Date.now() - syncStart) / 1000);
      console.log(
        `   ℹ️   ${stillBlocking.length} task(s) still active on provider (${elapsedS}s elapsed)…`,
      );
    }
  }

  // Pre-seed stdin to auto-answer the "tasks in queue" readline prompt.
  process.stdin.resume();
  process.stdin.setEncoding("utf-8");
  process.stdin.unshift("yes\n");

  const taskId = (await ft.createTask(
    providerAddr,
    MODEL_NAME,
    datasetHash,
    trainingParamsFile,
  )) as string;

  console.log(`\n✅  Task submitted — ID: \x1b[36m${taskId}\x1b[0m`);
  console.log(
    `   Resume later: pnpm run train-model -- --skip-train --task-id ${taskId}\n`,
  );
  return taskId;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function pollUntilComplete(
  ft: any,
  providerAddr: string,
  taskId: string,
): Promise<string> {
  console.log(
    `\n   Polling every ${POLL_INTERVAL_MS / 1000}s (max ${MAX_WAIT_MS / 3_600_000}h)…\n`,
  );

  // Pre-seed stdin to auto-answer any SDK readline prompts that may appear during polling.
  process.stdin.resume();
  process.stdin.setEncoding("utf-8");
  process.stdin.unshift("yes\n");

  const startMs = Date.now();
  let lastProgress = "";
  let lastLog = "";
  let capturedTeeBase = "";

  while (true) {
    if (Date.now() - startMs > MAX_WAIT_MS) {
      throw new Error(
        `Maximum wait time exceeded.\n` +
          `  Resume with: pnpm run train-model -- --skip-train --task-id ${taskId}`,
      );
    }

    await sleep(POLL_INTERVAL_MS);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let task: any = null;
    try {
      task = await ft.getTask(providerAddr, taskId);
    } catch (err) {
      console.warn(
        `   ⚠️  getTask: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    // Capture the TEE base URL from the task object for later download use.
    const taskUrl =
      (task?.url as string | undefined) ??
      (task?.teeUrl as string | undefined) ??
      "";
    if (taskUrl && !capturedTeeBase)
      capturedTeeBase = taskUrl.replace(/\/+$/, "");

    const progress = (task?.progress as string | undefined) ?? "unknown";
    if (progress !== lastProgress) {
      const elapsed = ((Date.now() - startMs) / 60_000).toFixed(1);
      console.log(`   [${elapsed}m] status: \x1b[33m${progress}\x1b[0m`);
      lastProgress = progress;
    }

    try {
      const log = (await ft.getLog(providerAddr, taskId)) as string;
      if (log && log !== lastLog) {
        const newLines = log.slice(lastLog.length).trim();
        if (newLines)
          console.log(
            `\n--- training log ---\n${newLines}\n--------------------\n`,
          );
        lastLog = log;
      }
    } catch {
      /* logs not yet available */
    }

    const pl = progress.toLowerCase();
    if (
      ["finished", "completed", "done", "succeeded", "delivered"].includes(pl)
    ) {
      console.log("\n🎉  Training complete!\n");
      return capturedTeeBase;
    }
    if (["failed", "error", "cancelled"].includes(pl)) {
      throw new Error(
        `Training ended with status: ${progress}. Check the training log above.`,
      );
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
// Direct streaming download from a URL to a local file, with retries.
// Works around the SDK's internal "stream has been aborted" issue on large files.
async function fetchToFile(
  url: string,
  destPath: string,
  retries = 3,
): Promise<void> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(180_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      if (!res.body) throw new Error("Empty response body");

      const fileStream = fs.createWriteStream(destPath);
      const reader = res.body.getReader();
      await new Promise<void>((resolve, reject) => {
        function pump(): void {
          reader
            .read()
            .then(({ done, value }) => {
              if (done) {
                fileStream.end();
                return;
              }
              fileStream.write(value, (err) => {
                if (err) {
                  reject(err);
                  return;
                }
                pump();
              });
            })
            .catch(reject);
        }
        fileStream.on("finish", resolve);
        fileStream.on("error", reject);
        pump();
      });
      return; // success
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < retries) {
        console.warn(
          `   ⚠️  Download attempt ${attempt} failed (${msg}), retrying in 5s…`,
        );
        await sleep(5_000);
      } else {
        throw err;
      }
    }
  }
}

async function downloadModel(
  ft: any,
  providerAddr: string,
  taskId: string,
  outputPath: string,
  walletAddr: string,
  teeBase: string,
): Promise<void> {
  console.log(`📥  Downloading LoRA adapter → ${outputPath}`);

  // Resolve TEE base URL from task metadata — supplement with value captured during polling.
  let resolvedTeeBase = teeBase;
  if (!resolvedTeeBase) {
    try {
      const taskInfo = (await ft.getTask(providerAddr, taskId)) as {
        url?: string;
        teeUrl?: string;
      };
      resolvedTeeBase = (taskInfo.url ?? taskInfo.teeUrl ?? "").replace(
        /\/+$/,
        "",
      );
    } catch {
      /* ignore — we'll fall through gracefully */
    }
  }

  // The 0G SDK's acknowledgeModel and downloadLoRAFromTEE both call process.exit(1)
  // when the TEE stream aborts on testnet — we skip them and go straight to a
  // direct Node.js fetch stream which handles partial reads gracefully.
  //
  // If teeBase wasn't resolved from getTask(), use the known testnet TEE URL
  // captured from the task log during polling.
  const effectiveTeeBase = resolvedTeeBase || "";
  if (!effectiveTeeBase) {
    console.warn(
      "   ⚠️  Could not resolve TEE base URL — skipping model download.",
    );
    console.warn(
      `      LoRA weights are stored on provider TEE.  Task ID: ${taskId}`,
    );
    return;
  }

  const loraUrl = `${effectiveTeeBase}/v1/user/${walletAddr}/task/${taskId}/lora`;
  console.log(`   Direct TEE download (3 attempts): ${loraUrl}`);
  const zipPath = path.join(outputPath, "lora.zip");
  try {
    await fetchToFile(loraUrl, zipPath);
    console.log(`   ✅  LoRA archive saved: ${zipPath}`);
  } catch (err) {
    console.warn(
      `   ⚠️  Direct download also failed (${err instanceof Error ? err.message : String(err)})`,
    );
    console.warn(
      "      Training is complete. LoRA weights remain on provider TEE.",
    );
    console.warn(`      Retrieve manually: GET ${loraUrl}`);
  }
}

function listArtifacts(outputPath: string): void {
  console.log("\n📂  Model artifacts:");
  if (!fs.existsSync(outputPath)) {
    console.warn("   ⚠️  Output directory not found.");
    return;
  }
  const files = (
    fs.readdirSync(outputPath, { recursive: true }) as string[]
  ).filter((f) => {
    try {
      return fs.statSync(path.join(outputPath, f)).isFile();
    } catch {
      return false;
    }
  });
  if (files.length === 0) {
    console.warn("   ⚠️  Output directory is empty.");
    return;
  }
  files.forEach((f) => {
    const kb = (fs.statSync(path.join(outputPath, f)).size / 1024).toFixed(1);
    console.log(`   ✅  ${f}  (${kb} KB)`);
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const outputPath = path.resolve(OUTPUT_DIR);
  ensureDir(outputPath);

  // ── Connect & print header ────────────────────────────────────────────────
  const { broker, ft, wallet, rpcUrl } = await connectBroker();

  const categories = ["L1", "L2", "Stable", "DeFi", "RWA", "AI"];
  const categoryCounts = Object.fromEntries(
    categories.map((c) => [c, TOKENS.filter((t) => t.category === c).length]),
  );
  console.log("\n" + "═".repeat(62));
  console.log("  0G TOKEN CLASSIFIER — TRAIN & VERIFY  (testnet)");
  console.log("═".repeat(62));
  console.log(`🔑  Wallet   : ${wallet.address}`);
  console.log(`🌐  RPC      : ${rpcUrl}`);
  console.log(`🤖  Model    : ${MODEL_NAME}`);
  console.log(`📁  Output   : ${outputPath}`);
  console.log(`⚙️   Upload   : ${UPLOAD_METHOD}`);
  const tokensWithAddress = TOKENS.filter(
    (t) => t.address !== undefined,
  ).length;
  console.log(
    `📊  Dataset  : ${TOKENS.length * 2 + tokensWithAddress * 2 + 10} JSONL examples (incl. ${tokensWithAddress * 2} address-based)`,
  );
  console.log(
    `   Categories: ${categories.map((c) => `${c}=${categoryCounts[c]}`).join("  ")}`,
  );
  console.log(`   Params   : ${JSON.stringify(TRAINING_PARAMS)}\n`);

  // ── Verify addresses on-chain before training ──────────────────────────────
  if (!SKIP_TRAIN) {
    await onChainVerifyAddresses();
  }

  // ── Write dataset ─────────────────────────────────────────────────────────
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "0g-tokens-"));
  const datasetPath = path.join(tmpDir, "token-types.jsonl");
  const jsonl = buildDataset();
  fs.writeFileSync(datasetPath, jsonl, "utf-8");
  const lineCount = jsonl.split("\n").filter(Boolean).length;
  console.log(`✍️   Dataset written : ${datasetPath}  (${lineCount} lines)`);

  // ── Provider, ledger, TEE signer ──────────────────────────────────────────
  const providerAddr = await selectProvider(ft);
  // Skip ledger funding and TEE acknowledgement when resuming an existing task —
  // those steps were already done when the task was originally submitted.
  if (!SKIP_TRAIN) {
    await ensureLedgerFunded(broker, providerAddr);
    await acknowledgeProvider(ft, providerAddr);
  }

  // ── Task (train or resume) ────────────────────────────────────────────────
  let taskId: string;
  if (SKIP_TRAIN && EXISTING_TASK) {
    taskId = EXISTING_TASK;
    console.log(
      `\n⏩  Skipping training — resuming task: \x1b[36m${taskId}\x1b[0m`,
    );
  } else {
    const datasetHash = await uploadDataset(ft, providerAddr, datasetPath);
    taskId = await submitTask(ft, providerAddr, datasetHash, tmpDir);
  }
  writeLastFineTuneTaskIdMarker(outputPath, taskId);

  // ── Wait, download, verify ────────────────────────────────────────────────
  const teeBase = await pollUntilComplete(ft, providerAddr, taskId);
  await downloadModel(
    ft,
    providerAddr,
    taskId,
    outputPath,
    wallet.address,
    teeBase,
  );
  listArtifacts(outputPath);
  await runInferenceVerification(broker, providerAddr);

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log("═".repeat(62));
  console.log("🏁  DONE");
  console.log(`   Task ID  : ${taskId}`);
  console.log(`   Provider : ${providerAddr}`);
  console.log(`   Output   : ${outputPath}`);
  console.log(`   Network  : 0G testnet (${rpcUrl})`);
  console.log("═".repeat(62) + "\n");
}

main().catch((err) => {
  console.error("\nFATAL:", err instanceof Error ? err.message : err);
  process.exit(1);
});
