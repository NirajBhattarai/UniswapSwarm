#!/usr/bin/env tsx
/**
 * check-model.ts
 *
 * Checks whether a 0G fine-tuning task completed successfully and verifies
 * the trained model classifies crypto tokens correctly via live inference.
 *
 * Runs three checks:
 *   1. Task status  — fetches on-chain task status (Finished / Failed / …)
 *   2. Artifacts    — inspects local LoRA adapter files in the output directory
 *   3. Inference    — swarm-aligned prompts (L1/L2/Stable/DeFi/RWA/AI) from @swarm/shared
 *
 * Prints a per-category accuracy report and an overall grade:
 *   EXCELLENT  100%  |  GOOD  ≥80%  |  FAIR  ≥60%  |  POOR  <60%
 *
 * Usage:
 *   pnpm run check-model
 *   pnpm run check-model -- --task-id <uuid>
 *   pnpm run check-model -- --provider <addr>
 *   pnpm run check-model -- --output ./output/token-classifier
 *   pnpm run check-model -- --extra-stable-addresses 0x...,0x...
 *
 * Stable token addresses default from @swarm/shared (same registry as swarm agents).
 * Pass --extra-stable-addresses to add more Ethereum mainnet checks (expects category Stable).
 *
 * Reads from .env:
 *   ZG_PRIVATE_KEY          – 64-char hex private key (testnet wallet)
 *   ZG_CHAIN_RPC            – 0G EVM RPC (default: https://evmrpc-testnet.0g.ai)
 *   ZG_FINE_TUNE_TASK_ID    – optional default when --task-id is omitted
 *
 * Task id resolution (first match wins):
 *   1. --task-id <uuid>
 *   2. ZG_FINE_TUNE_TASK_ID
 *   3. <output>/.last-fine-tune-task-id (written by train-model after submit)
 */

import "dotenv/config";
import path from "path";
import fs from "fs";
import { createZGComputeNetworkBroker } from "@0glabs/0g-serving-broker";
import { ethers } from "ethers";
import {
  ETHEREUM_MAINNET_RESEARCHER_TOKEN_REGISTRY,
  ETHEREUM_MAINNET_STABLECOIN_DEFS,
  TOKENS,
} from "@swarm/shared";

// ─── CLI args ─────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const cur = argv[i];
    if (cur && cur.startsWith("--")) {
      const key  = cur.slice(2);
      const next = argv[i + 1];
      const val  = next !== undefined && !next.startsWith("--") ? (argv[++i] ?? "true") : "true";
      result[key] = val;
    }
  }
  return result;
}

const args        = parseArgs(process.argv.slice(2));
const PROVIDER    = args["provider"] ?? "";
const OUTPUT_DIR  = args["output"]   ?? "./output/token-classifier";
const MODEL_NAME  = args["model"]    ?? "Qwen2.5-0.5B-Instruct";
const EXTRA_STABLE_ADDRESSES = args["extra-stable-addresses"] ?? "";

function resolveFineTuneTaskId(cliTaskId: string): string {
  const fromCli = cliTaskId.trim();
  if (fromCli && fromCli !== "true") return fromCli;
  const fromEnv = (process.env["ZG_FINE_TUNE_TASK_ID"] ?? "").trim();
  if (fromEnv) return fromEnv;
  const marker = path.join(path.resolve(OUTPUT_DIR), ".last-fine-tune-task-id");
  try {
    const fromFile = fs.readFileSync(marker, "utf-8").trim().split(/\s+/)[0] ?? "";
    if (fromFile) return fromFile;
  } catch { /* missing or unreadable */ }
  return "";
}

const TASK_ID = resolveFineTuneTaskId(args["task-id"] ?? "");

if (!TASK_ID) {
  console.error("ERROR: No fine-tune task id. Use one of:");
  console.error("  • pnpm run check-model -- --task-id <uuid>");
  console.error("  • Set ZG_FINE_TUNE_TASK_ID in .env");
  console.error(`  • Run train-model (writes ${path.join(path.resolve(OUTPUT_DIR), ".last-fine-tune-task-id")})`);
  process.exit(1);
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function extractPrivateKey(raw: string): string {
  const match = raw.match(/(?:0x)?([0-9a-fA-F]{64})/);
  if (!match) throw new Error(`ZG_PRIVATE_KEY is not a valid 64-char hex key. Got: "${raw.slice(0, 20)}…"`);
  return match[1]!;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Inference test data ──────────────────────────────────────────────────────

const SYSTEM_PROMPT =
  "You are a cryptocurrency token classification expert for the Uniswap swarm pipeline. " +
  "Classify tokens into exactly one of these six categories:\n" +
  "  L1   (Layer 1)         – Native tokens of base-layer blockchains\n" +
  "  L2   (Layer 2)         – Tokens of Layer 2 scaling solutions and rollups\n" +
  "  Stable (Stablecoins)   – USD-pegged ERC-20s (USDC, USDT, DAI, …) used as quote liquidity\n" +
  "  DeFi (Decentralised Finance) – Tokens of on-chain financial protocols\n" +
  "  RWA  (Real World Assets)     – Tokens representing real-world assets on-chain\n" +
  "  AI   (Artificial Intelligence) – Tokens of AI and machine-learning protocols\n" +
  "You can also identify and classify tokens by their Ethereum mainnet ERC-20 contract address.\n" +
  "Always name the chosen category explicitly as L1, L2, Stable, DeFi, RWA, or AI (exact spelling) " +
  "before any explanation — even for tricky or ambiguous cases.";

type TestCategory = "L1" | "L2" | "Stable" | "DeFi" | "RWA" | "AI";

interface TestCase {
  q:                string;
  expectedCategory: string;
  category:         TestCategory;
}

function normalizeAddress(a: string): string | null {
  try {
    return ethers.getAddress(a.trim());
  } catch {
    return null;
  }
}

/**
 * Swarm-aligned checks, hard disambiguation (“brutal”) traps, registry-backed addresses,
 * plus optional user-supplied stable addresses.
 */
function buildTestCases(extraStableAddressesCsv: string): TestCase[] {
  const reg = ETHEREUM_MAINNET_RESEARCHER_TOKEN_REGISTRY;
  const weth = reg["WETH"]!.address;
  const usdc = reg["USDC"]!.address;
  const wbtc = TOKENS.WBTC;

  const extraStable: TestCase[] = extraStableAddressesCsv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(normalizeAddress)
    .filter((x): x is string => x !== null)
    .map((addr) => ({
      q:        `Classify the token at Ethereum address ${addr}`,
      expectedCategory: "Stable",
      category: "Stable",
    }));

  const stableSlice = ETHEREUM_MAINNET_STABLECOIN_DEFS.slice(0, 5);

  /** Taxonomy stress-tests — keep prompts aligned with getBrutalChallenges() in train-model.ts */
  const brutal: TestCase[] = [
    {
      q:
        "In our taxonomy, what is the difference between L1 and L2 tokens in one sentence, " +
        "then classify OP (Optimism) as exactly one of: L1, L2, Stable, DeFi, RWA, AI.",
      expectedCategory: "L2",
      category: "L2",
    },
    {
      q:
        "MATIC on Ethereum mainnet is the legacy Polygon ERC-20. Is it L1, L2, Stable, DeFi, RWA, or AI? " +
        "Answer with exactly one category label.",
      expectedCategory: "L2",
      category: "L2",
    },
    {
      q:
        "Someone says USDC is 'DeFi money' because it trades on DEXes. For classification is USDC Stable or DeFi? " +
        "Pick one label only.",
      expectedCategory: "Stable",
      category: "Stable",
    },
    {
      q:
        "DAI is minted by MakerDAO. Is DAI classified as Stable or DeFi in our six-category system? One label only.",
      expectedCategory: "Stable",
      category: "Stable",
    },
    {
      q:
        "WBTC is a wrapped Bitcoin ERC-20 on Ethereum. Classify WBTC: L1, L2, Stable, DeFi, RWA, or AI?",
      expectedCategory: "L1",
      category: "L1",
    },
    {
      q:
        "LINK powers Chainlink oracles. Some confuse it with AI infrastructure. Classify LINK: DeFi or AI? One word label.",
      expectedCategory: "DeFi",
      category: "DeFi",
    },
    {
      q:
        "LDO is governance for Lido liquid staking. Classify LDO as L2 or DeFi — one label only.",
      expectedCategory: "DeFi",
      category: "DeFi",
    },
    {
      q:
        "MKR is Maker governance, not the DAI stablecoin itself. Classify MKR: Stable or DeFi?",
      expectedCategory: "DeFi",
      category: "DeFi",
    },
    {
      q:
        "PAXG is allocated to physical gold. Is it RWA or L1? One category.",
      expectedCategory: "RWA",
      category: "RWA",
    },
    {
      q:
        "CRVUSD is Curve’s USD-pegged stablecoin. Classify: Stable or DeFi?",
      expectedCategory: "Stable",
      category: "Stable",
    },
    {
      q:
        "FET (Fetch.ai) is used for autonomous agents. Classify: AI or DeFi?",
      expectedCategory: "AI",
      category: "AI",
    },
    {
      q:
        "Native gas token of Ethereum mainnet (ETH): L1 or L2?",
      expectedCategory: "L1",
      category: "L1",
    },
    {
      q:
        "UNI is Uniswap DEX governance. Not a stablecoin. One category from our six.",
      expectedCategory: "DeFi",
      category: "DeFi",
    },
    {
      q: `Raw address only, no symbol hint: classify mainnet ${reg["ARB"]!.address}`,
      expectedCategory: "L2",
      category: "L2",
    },
    {
      q: `Contract ${reg["UNI"]!.address} on Ethereum — L1, L2, Stable, DeFi, RWA, or AI?`,
      expectedCategory: "DeFi",
      category: "DeFi",
    },
    {
      q: `What category for ERC-20 at ${wbtc}?`,
      expectedCategory: "L1",
      category: "L1",
    },
    // ── LST / liquid staking (DeFi, not L1) ─────────────────────────────────
    {
      q: "stETH is Lido's liquid staking receipt token for ETH. Is stETH L1 or DeFi?",
      expectedCategory: "DeFi",
      category: "DeFi",
    },
    {
      q: "wstETH (wrapped stETH) and cbETH (Coinbase staked ETH) — are these L1 or DeFi?",
      expectedCategory: "DeFi",
      category: "DeFi",
    },
    {
      q: "rETH is Rocket Pool's staked ETH receipt token. L1 or DeFi? One label.",
      expectedCategory: "DeFi",
      category: "DeFi",
    },
    // ── Oracle tokens (DeFi, not AI) ─────────────────────────────────────────
    {
      q: "LINK (Chainlink) feeds real-world price data to smart contracts. DeFi or AI? One label.",
      expectedCategory: "DeFi",
      category: "DeFi",
    },
    {
      q: "BAND (Band Protocol) is a cross-chain oracle. Classify: DeFi or AI?",
      expectedCategory: "DeFi",
      category: "DeFi",
    },
    {
      q: "API3 provides first-party oracle APIs to DeFi protocols. DeFi or AI?",
      expectedCategory: "DeFi",
      category: "DeFi",
    },
    // ── L1 streaming / storage chains (NOT AI) ───────────────────────────────
    {
      q: "THETA is the native token of Theta Network, a blockchain for video streaming. L1 or AI?",
      expectedCategory: "L1",
      category: "L1",
    },
    {
      q: "ANKR provides decentralised RPC and cloud-compute infrastructure. DeFi or AI?",
      expectedCategory: "DeFi",
      category: "DeFi",
    },
    // ── Meme tokens (DeFi, not L1 or AI) ─────────────────────────────────────
    {
      q: "SHIB is an Ethereum ERC-20 meme token with ShibaSwap DEX. L1, DeFi, or AI?",
      expectedCategory: "DeFi",
      category: "DeFi",
    },
    {
      q: "PEPE is an Ethereum ERC-20 meme token. L1 or DeFi? One label.",
      expectedCategory: "DeFi",
      category: "DeFi",
    },
    // ── RPL and ENS disambiguation ────────────────────────────────────────────
    {
      q: "RPL is Rocket Pool's governance token for ETH staking. Is RPL L2 or DeFi? One label.",
      expectedCategory: "DeFi",
      category: "DeFi",
    },
    {
      q: "ENS governs the Ethereum Name Service on-chain registry. L1, L2, or DeFi?",
      expectedCategory: "DeFi",
      category: "DeFi",
    },
    // ── Nuanced stablecoins vs DeFi governance ───────────────────────────────
    {
      q: "FRAX is the USD-pegged stablecoin of Frax Finance (FXS is governance). Classify FRAX: Stable or DeFi?",
      expectedCategory: "Stable",
      category: "Stable",
    },
    {
      q: "LUSD is Liquity Protocol's dollar-pegged stablecoin. Stable or DeFi?",
      expectedCategory: "Stable",
      category: "Stable",
    },
    {
      q: "USDE is Ethena's synthetic USD stablecoin. Stable or DeFi?",
      expectedCategory: "Stable",
      category: "Stable",
    },
    // ── GRT: AI not DeFi ─────────────────────────────────────────────────────
    {
      q: "GRT (The Graph) indexes blockchain data for queries. AI or DeFi in our taxonomy?",
      expectedCategory: "AI",
      category: "AI",
    },
    // ── Address-only traps without symbol hint ────────────────────────────────
    {
      q: `Classify ${reg["RNDR"]!.address} — AI or DeFi? One label only.`,
      expectedCategory: "AI",
      category: "AI",
    },
    {
      q: `${reg["MATIC"]!.address} is on Ethereum mainnet. L1 or L2? One label.`,
      expectedCategory: "L2",
      category: "L2",
    },
    {
      q: `ERC-20 at ${reg["LDO"]!.address} — DeFi or L2? One label.`,
      expectedCategory: "DeFi",
      category: "DeFi",
    },
  ];

  return [
    // L1 / quote context
    { q: "What type of token is ETH?",           expectedCategory: "L1",     category: "L1" },
    { q: `Classify the token at Ethereum address ${weth}`, expectedCategory: "L1", category: "L1" },
    { q: "Classify the token: Solana (SOL)",     expectedCategory: "L1",     category: "L1" },
    // L2
    { q: "What type of token is ARB?",           expectedCategory: "L2",     category: "L2" },
    { q: "What type of token is POL?",           expectedCategory: "L2",     category: "L2" },
    { q: "Classify the token: Starknet (STRK)",  expectedCategory: "L2",     category: "L2" },
    // Stable — symbols from shared defs (agent isStablecoin list)
    ...stableSlice.map((t) => ({
      q:        `What type of token is ${t.symbol}?`,
      expectedCategory: "Stable",
      category: "Stable" as const,
    })),
    { q: `What token has Ethereum mainnet address ${usdc}?`, expectedCategory: "Stable", category: "Stable" },
    { q: `Classify the token at Ethereum address ${stableSlice[2]!.address}`, expectedCategory: "Stable", category: "Stable" },
    // DeFi — volatile / governance (not stable)
    { q: "What type of token is UNI?",           expectedCategory: "DeFi",   category: "DeFi" },
    { q: "What type of token is AAVE?",          expectedCategory: "DeFi",   category: "DeFi" },
    { q: `Classify the token at Ethereum address ${reg["LINK"]!.address}`, expectedCategory: "DeFi", category: "DeFi" },
    // RWA
    { q: "What type of token is ONDO?",          expectedCategory: "RWA",    category: "RWA" },
    { q: "What type of token is PAXG?",          expectedCategory: "RWA",    category: "RWA" },
    // AI
    { q: "What type of token is FET?",           expectedCategory: "AI",     category: "AI" },
    { q: "What type of token is RNDR?",          expectedCategory: "AI",     category: "AI" },
    // ── New token checks ───────────────────────────────────────────────────────
    { q: "What type of token is LINK?",          expectedCategory: "DeFi",   category: "DeFi" },
    { q: "What type of token is stETH?",         expectedCategory: "DeFi",   category: "DeFi" },
    { q: "What type of token is wstETH?",        expectedCategory: "DeFi",   category: "DeFi" },
    { q: "What type of token is cbETH?",         expectedCategory: "DeFi",   category: "DeFi" },
    { q: "What type of token is rETH?",          expectedCategory: "DeFi",   category: "DeFi" },
    { q: "What type of token is RPL?",           expectedCategory: "DeFi",   category: "DeFi" },
    { q: "What type of token is THETA?",         expectedCategory: "L1",     category: "L1" },
    { q: "What type of token is SHIB?",          expectedCategory: "DeFi",   category: "DeFi" },
    { q: "What type of token is PEPE?",          expectedCategory: "DeFi",   category: "DeFi" },
    { q: "Classify the token at Ethereum address 0x514910771AF9Ca656af840dff83E8264EcF986CA",  expectedCategory: "DeFi",   category: "DeFi" },
    { q: "What token has Ethereum mainnet address 0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84?", expectedCategory: "DeFi",   category: "DeFi" },
    { q: "Classify the token at Ethereum address 0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0",  expectedCategory: "DeFi",   category: "DeFi" },
    { q: "What token has Ethereum mainnet address 0xae78736Cd615f374D3085123A210448E74Fc6393?", expectedCategory: "DeFi",   category: "DeFi" },
    { q: "Classify the token at Ethereum address 0x3883f5e181fccaF8410FA61e12b59BAd963fb645",  expectedCategory: "L1",     category: "L1" },
    { q: "What token has Ethereum mainnet address 0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE?", expectedCategory: "DeFi",   category: "DeFi" },
    { q: "Classify the token at Ethereum address 0x6982508145454Ce325dDbE47a25d4ec3d2311933",  expectedCategory: "DeFi",   category: "DeFi" },
    ...brutal,
    ...extraStable,
  ];
}

const TEST_CASES = buildTestCases(EXTRA_STABLE_ADDRESSES);

// ─── Check 1: task status ──────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function checkTaskStatus(ft: any, providerAddr: string): Promise<string> {
  console.log("\n📋  Check 1 — Task status");
  console.log("─".repeat(40));
  try {
    const task     = await ft.getTask(providerAddr, TASK_ID);
    const status   = (task?.progress as string | undefined) ?? "unknown";
    const finished = ["finished", "completed", "done", "succeeded", "delivered"].includes(
      status.toLowerCase(),
    );
    const failed   = ["failed", "error", "cancelled"].includes(status.toLowerCase());
    const icon     = finished ? "✅" : failed ? "❌" : "⏳";
    const color    = finished ? "\x1b[32m" : failed ? "\x1b[31m" : "\x1b[33m";
    console.log(`   ${icon}  Status: ${color}${status}\x1b[0m`);
    if (!finished && !failed) {
      console.log("   ℹ️   Training may still be in progress.");
    }
    return status;
  } catch (err) {
    console.warn(`   ⚠️  Could not fetch task: ${err instanceof Error ? err.message : String(err)}`);
    return "unknown";
  }
}

// ─── Check 2: local artifacts ─────────────────────────────────────────────────

function checkArtifacts(outputPath: string): { count: number; totalKB: number } {
  console.log("\n📂  Check 2 — Local model artifacts");
  console.log("─".repeat(40));
  if (!fs.existsSync(outputPath)) {
    console.warn(`   ⚠️  Directory not found: ${outputPath}`);
    return { count: 0, totalKB: 0 };
  }

  const files = (fs.readdirSync(outputPath, { recursive: true }) as string[])
    .map((f) => ({ name: f, full: path.join(outputPath, f) }))
    .filter(({ full }) => { try { return fs.statSync(full).isFile(); } catch { return false; } });

  if (files.length === 0) {
    console.warn("   ⚠️  Output directory is empty — model may not have downloaded yet.");
    return { count: 0, totalKB: 0 };
  }

  let totalKB = 0;
  files.forEach(({ name, full }) => {
    const kb = fs.statSync(full).size / 1024;
    totalKB += kb;
    console.log(`   ✅  ${name}  (${kb.toFixed(1)} KB)`);
  });
  console.log(`   Total: ${files.length} file(s), ${(totalKB / 1024).toFixed(2)} MB`);
  return { count: files.length, totalKB };
}

// ─── Check 3: live inference ──────────────────────────────────────────────────

interface InferenceResult {
  passed:     number;
  failed:     number;
  total:      number;
  byCategory: Record<TestCategory, { passed: number; total: number }>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runInferenceCheck(broker: any, providerAddr: string): Promise<InferenceResult> {
  const result: InferenceResult = {
    passed: 0, failed: 0, total: TEST_CASES.length,
    byCategory: {
      L1:     { passed: 0, total: 0 },
      L2:     { passed: 0, total: 0 },
      Stable: { passed: 0, total: 0 },
      DeFi:   { passed: 0, total: 0 },
      RWA:    { passed: 0, total: 0 },
      AI:     { passed: 0, total: 0 },
    },
  };

  console.log(`\n🔬  Check 3 — Live inference (${TEST_CASES.length} prompts, incl. Stable from shared registry)`);
  console.log("─".repeat(40));

  // List inference services
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let services: any[] = [];
  try {
    services = await broker.inference.listService() as typeof services;
  } catch (err) {
    console.warn(`   ⚠️  Could not list inference services: ${err instanceof Error ? err.message : String(err)}`);
    return result;
  }
  if (services.length === 0) {
    console.warn("   ⚠️  No inference services available.");
    return result;
  }

  // Pick service — prefer same provider as fine-tuning
  const svc = (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    services.find((s: any) => s.provider?.toLowerCase() === providerAddr.toLowerCase()) ??
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    services.find((s: any) => s.serviceType === "chatbot") ??
    services[0]
  ) as { provider: string; model?: string; url?: string; endpoint?: string };

  console.log(`   Provider : ${svc.provider.slice(0, 14)}…  model: ${svc.model ?? "(auto)"}`);

  // Acknowledge (non-fatal)
  try {
    await (broker.inference.acknowledgeProviderSigner(svc.provider) as Promise<unknown>).catch(() => null);
  } catch { /* non-fatal */ }

  // Resolve endpoint
  let endpoint = svc.url ?? svc.endpoint ?? "";
  try {
    const meta = await broker.inference.getServiceMetadata(svc.provider) as { endpoint?: string };
    endpoint = meta.endpoint ?? endpoint;
  } catch { /* non-fatal */ }

  if (!endpoint) {
    console.warn("   ⚠️  Could not resolve inference endpoint.");
    return result;
  }

  // Auth headers
  let headers: Record<string, string> = {};
  try {
    headers = await broker.inference.getRequestHeaders(svc.provider) as Record<string, string>;
  } catch (err) {
    console.warn(`   ⚠️  getRequestHeaders failed: ${err instanceof Error ? err.message : String(err)}`);
    return result;
  }

  console.log(`   Endpoint : ${endpoint}\n`);

  // Run prompts (6.5s gap — same as train-model.ts; inference tier is often ~10 req/min)
  for (const { q, expectedCategory, category } of TEST_CASES) {
    await sleep(6_500);
    result.byCategory[category].total++;

    const body = JSON.stringify({
      model:       svc.model ?? MODEL_NAME,
      messages:    [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: q }],
      max_tokens:  120,
      temperature: 0.1,
    });

    try {
      const res = await fetch(`${endpoint}/chat/completions`, {
        method:  "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body,
      });

      if (!res.ok) {
        if (res.status === 429) {
          console.log(`   ⏳  Rate limited — waiting 65s before retry…`);
          await sleep(65_000);
          const retry = await fetch(`${endpoint}/chat/completions`, {
            method:  "POST",
            headers: { ...headers, "Content-Type": "application/json" },
            body,
          });
          if (retry.ok) {
            const jsonRetry = await retry.json() as { choices: Array<{ message: { content: string } }> };
            const answerRetry = (jsonRetry.choices[0]?.message?.content ?? "").trim();
            const correctRetry = answerRetry.toUpperCase().includes(expectedCategory.toUpperCase());
            if (correctRetry) {
              console.log(`   ✅  [${category.padEnd(6)}]  "${q.slice(0, 55)}"`);
              console.log(`             → ${answerRetry.slice(0, 100)}`);
              result.passed++;
              result.byCategory[category].passed++;
            } else {
              console.log(`   ❌  [${category.padEnd(6)}]  "${q.slice(0, 55)}"`);
              console.log(`             Expected: ${expectedCategory}  |  Got: ${answerRetry.slice(0, 100)}`);
              result.failed++;
            }
            continue;
          }
        }
        console.log(`   ❌  [${category.padEnd(6)}]  "${q.slice(0, 55)}"  → HTTP ${res.status}`);
        result.failed++;
        continue;
      }

      const json    = await res.json() as { choices: Array<{ message: { content: string } }> };
      const answer  = (json.choices[0]?.message?.content ?? "").trim();
      const correct = answer.toUpperCase().includes(expectedCategory.toUpperCase());

      if (correct) {
        console.log(`   ✅  [${category.padEnd(6)}]  "${q.slice(0, 55)}"`);
        console.log(`             → ${answer.slice(0, 100)}`);
        result.passed++;
        result.byCategory[category].passed++;
      } else {
        console.log(`   ❌  [${category.padEnd(6)}]  "${q.slice(0, 55)}"`);
        console.log(`             Expected: ${expectedCategory}  |  Got: ${answer.slice(0, 100)}`);
        result.failed++;
      }
    } catch (err) {
      console.log(`   ⚠️  [${category.padEnd(6)}]  "${q.slice(0, 55)}" — ${err instanceof Error ? err.message : String(err)}`);
      result.failed++;
    }
  }

  return result;
}

// ─── Report ───────────────────────────────────────────────────────────────────

function printReport(
  taskStatus: string,
  artifacts:  { count: number; totalKB: number },
  inference:  InferenceResult,
): void {
  const pct   = inference.total > 0 ? Math.round((inference.passed / inference.total) * 100) : 0;
  const grade = pct === 100 ? "🏆 EXCELLENT" : pct >= 80 ? "✅ GOOD" : pct >= 60 ? "⚠️  FAIR" : "❌ POOR";

  const taskOk      = ["finished", "completed", "done", "succeeded", "delivered"].includes(taskStatus.toLowerCase());
  const artifactOk  = artifacts.count > 0;
  const inferenceOk = pct >= 80;

  console.log("\n" + "═".repeat(62));
  console.log("  TRAINING QUALITY REPORT");
  console.log("═".repeat(62));
  console.log(`   Task ID     : ${TASK_ID}`);
  console.log(`   Task status : ${taskOk ? "\x1b[32m" : "\x1b[33m"}${taskStatus}\x1b[0m   ${taskOk ? "✅" : "⏳"}`);
  console.log(`   Artifacts   : ${artifacts.count} file(s)  (${(artifacts.totalKB / 1024).toFixed(2)} MB)   ${artifactOk ? "✅" : "⚠️"}`);
  console.log(`   Inference   : ${inference.passed}/${inference.total} correct  (${pct}%)   ${inferenceOk ? "✅" : pct >= 60 ? "⚠️" : "❌"}`);

  console.log("\n   Accuracy by category:");
  const categories: readonly TestCategory[] = ["L1", "L2", "Stable", "DeFi", "RWA", "AI"];
  for (const cat of categories) {
    const { passed, total } = inference.byCategory[cat];
    if (total === 0) continue;
    const catPct  = Math.round((passed / total) * 100);
    const filled  = Math.round(catPct / 10);
    const bar     = "█".repeat(filled) + "░".repeat(10 - filled);
    const color   = catPct === 100 ? "\x1b[32m" : catPct >= 60 ? "\x1b[33m" : "\x1b[31m";
    console.log(`   ${cat.padEnd(6)}  [${color}${bar}\x1b[0m]  ${passed}/${total}  (${catPct}%)`);
  }

  console.log(`\n   Overall grade : ${grade}`);

  if (pct < 80) {
    const weakCats = categories.filter((c) => {
      const { passed, total } = inference.byCategory[c];
      return total > 0 && passed / total < 0.75;
    });
    console.log("\n   Suggestions to improve:");
    if (weakCats.length > 0) {
      console.log(`   • Weak categories: ${weakCats.join(", ")} — add more training examples for these`);
    }
    if (pct < 60) {
      console.log("   • Increase num_train_epochs (try 5–10 instead of 3)");
      console.log("   • Decrease learning_rate slightly (try 0.0001)");
    }
    console.log("   • Re-run: pnpm run train-model");
  }

  console.log("═".repeat(62) + "\n");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const ZG_CHAIN_RPC = process.env["ZG_CHAIN_RPC"] ?? "https://evmrpc-testnet.0g.ai";
  const privateKey   = extractPrivateKey(process.env["ZG_PRIVATE_KEY"] ?? "");

  console.log("\n" + "═".repeat(62));
  console.log("  0G MODEL QUALITY CHECK");
  console.log("═".repeat(62));
  console.log(`   Task ID  : ${TASK_ID}`);
  console.log(`   RPC      : ${ZG_CHAIN_RPC}`);

  const rpcProvider = new ethers.JsonRpcProvider(ZG_CHAIN_RPC);
  const wallet      = new ethers.Wallet(privateKey, rpcProvider);
  console.log(`   Wallet   : ${wallet.address}`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const broker = await createZGComputeNetworkBroker(wallet) as any;
  const ft     = broker.fineTuning;

  // Resolve provider
  let providerAddr = PROVIDER;
  if (!providerAddr) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const services: any[] = await ft.listService();
    if (services.length === 0) throw new Error("No fine-tuning services found on testnet.");
    providerAddr = services[0].provider as string;
    console.log(`   Provider : ${providerAddr}  (auto-discovered)`);
  } else {
    console.log(`   Provider : ${providerAddr}`);
  }

  // Run the three checks
  const taskStatus = await checkTaskStatus(ft, providerAddr);
  const artifacts  = checkArtifacts(path.resolve(OUTPUT_DIR));
  const inference  = await runInferenceCheck(broker, providerAddr);

  // Print consolidated report
  printReport(taskStatus, artifacts, inference);
}

main().catch((err) => {
  console.error("\nFATAL:", err instanceof Error ? err.message : err);
  process.exit(1);
});
