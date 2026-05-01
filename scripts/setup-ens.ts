#!/usr/bin/env tsx
/**
 * setup-ens.ts
 *
 * Creates subnames under uniswapswarm.eth (if they don't exist) and sets
 * the ETH address + display name text records for each Uniswap Swarm agent.
 *
 * Subnames managed:
 *   researcher.uniswapswarm.eth
 *   planner.uniswapswarm.eth
 *   risk.uniswapswarm.eth
 *   strategy.uniswapswarm.eth
 *   critic.uniswapswarm.eth
 *   executor.uniswapswarm.eth
 *
 * Usage:
 *   npm run setup-ens
 *
 * Required env vars (root .env):
 *   ENS_RPC_URL              — Sepolia JSON-RPC URL
 *   ENS_RECORDS_PRIVATE_KEY  — Approved delegate key (preferred, safe for CI)
 *                              OR ENS_OWNER_PRIVATE_KEY as a fallback
 *
 * Optional env vars (per-agent address overrides):
 *   AGENT_ADDRESS            — fallback address for all agents (defaults to signer wallet)
 *   ENS_AGENT_BASE_URL       — base URL written as text[url] on each subname
 *                              e.g. https://uniswapswarm-production.up.railway.app
 *                              defaults to http://localhost:4000
 *   ENS_ADDR_RESEARCHER      — override addr record for researcher.uniswapswarm.eth
 *   ENS_ADDR_PLANNER         — override addr record for planner.uniswapswarm.eth
 *   ENS_ADDR_RISK            — override addr record for risk.uniswapswarm.eth
 *   ENS_ADDR_STRATEGY        — override addr record for strategy.uniswapswarm.eth
 *   ENS_ADDR_CRITIC          — override addr record for critic.uniswapswarm.eth
 *   ENS_ADDR_EXECUTOR        — override addr record for executor.uniswapswarm.eth
 */

import "dotenv/config";
import { ethers } from "ethers";
import {
  ENS_CONTRACTS_BY_CHAIN,
  AGENT_ENS_NAMES,
  ENS_ROOT,
} from "@swarm/shared";

// ─── ABIs ─────────────────────────────────────────────────────────────────────

const REGISTRY_ABI = [
  "function resolver(bytes32 node) view returns (address)",
  "function owner(bytes32 node) view returns (address)",
  "function setSubnodeRecord(bytes32 node, bytes32 label, address owner, address resolver, uint64 ttl)",
] as const;

const NAME_WRAPPER_ABI = [
  "function ownerOf(uint256 id) view returns (address)",
  "function isWrapped(bytes32 node) view returns (bool)",
  "function setSubnodeRecord(bytes32 parentNode, string label, address owner, address resolver, uint64 ttl, uint32 fuses, uint64 expiry) returns (bytes32)",
] as const;

const PUBLIC_RESOLVER_ABI = [
  "function setAddr(bytes32 node, address addr)",
  "function addr(bytes32 node) view returns (address)",
  "function setText(bytes32 node, string key, string value)",
  "function text(bytes32 node, string key) view returns (string)",
] as const;

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const rpcUrl = process.env["ENS_RPC_URL"] ?? process.env["ETH_RPC_URL"];
  const privateKey =
    process.env["ENS_RECORDS_PRIVATE_KEY"] ??
    process.env["ENS_OWNER_PRIVATE_KEY"];

  if (!rpcUrl) {
    console.error("ERROR: ENS_RPC_URL is not set.");
    process.exit(1);
  }
  if (!privateKey) {
    console.error(
      "ERROR: Set ENS_RECORDS_PRIVATE_KEY (delegate) or ENS_OWNER_PRIVATE_KEY in .env.",
    );
    process.exit(1);
  }

  const usingDelegate = !!process.env["ENS_RECORDS_PRIVATE_KEY"];

  // Auto-detect chain and pick the right contract addresses
  const tempProvider = new ethers.JsonRpcProvider(rpcUrl);
  const { chainId } = await tempProvider.getNetwork();
  const chainIdNum = Number(chainId);
  const contracts =
    ENS_CONTRACTS_BY_CHAIN[chainIdNum as keyof typeof ENS_CONTRACTS_BY_CHAIN];
  if (!contracts) {
    console.error(
      `ERROR: No ENS contracts configured for chainId ${chainIdNum}.`,
    );
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl, chainIdNum, {
    staticNetwork: true,
  });
  const wallet = new ethers.Wallet(privateKey, provider);
  const fallbackAddress = process.env["AGENT_ADDRESS"] ?? wallet.address;
  const agentBaseUrl = (
    process.env["ENS_AGENT_BASE_URL"] ?? "http://localhost:4000"
  ).replace(/\/$/, "");

  console.log(`Network       : chainId ${chainIdNum}`);
  console.log(
    `Signer (${usingDelegate ? "delegate" : "owner"}) : ${wallet.address}`,
  );
  console.log(`Fallback addr : ${fallbackAddress}\n`);

  const registry = new ethers.Contract(
    contracts.registry,
    REGISTRY_ABI,
    wallet,
  );
  const nameWrapper = new ethers.Contract(
    contracts.nameWrapper,
    NAME_WRAPPER_ABI,
    wallet,
  );

  // ── Verify ownership of the root name ──────────────────────────────────────
  const rootNode = ethers.namehash(ENS_ROOT);
  const rootRegistryOwner: string = await registry.owner(rootNode);

  let rootIsWrapped = false;
  let rootEffectiveOwner = rootRegistryOwner;

  if (rootRegistryOwner.toLowerCase() === contracts.nameWrapper.toLowerCase()) {
    rootIsWrapped = true;
    rootEffectiveOwner = await nameWrapper.ownerOf(BigInt(rootNode));
  }

  if (rootEffectiveOwner.toLowerCase() !== wallet.address.toLowerCase()) {
    console.error(
      `ERROR: ${ENS_ROOT} is owned by ${rootEffectiveOwner}, not ${wallet.address}.\n` +
        `       Make sure ENS_OWNER_PRIVATE_KEY matches the owner of ${ENS_ROOT}.`,
    );
    process.exit(1);
  }

  console.log(
    `Root name : ${ENS_ROOT} (${rootIsWrapped ? "wrapped" : "unwrapped"})\n`,
  );

  // ── Per-agent address overrides ────────────────────────────────────────────
  const agentAddresses: Record<keyof typeof AGENT_ENS_NAMES, string> = {
    researcher: process.env["ENS_ADDR_RESEARCHER"] ?? fallbackAddress,
    planner: process.env["ENS_ADDR_PLANNER"] ?? fallbackAddress,
    risk: process.env["ENS_ADDR_RISK"] ?? fallbackAddress,
    strategy: process.env["ENS_ADDR_STRATEGY"] ?? fallbackAddress,
    critic: process.env["ENS_ADDR_CRITIC"] ?? fallbackAddress,
    executor: process.env["ENS_ADDR_EXECUTOR"] ?? fallbackAddress,
  };

  for (const [agentId, ensName] of Object.entries(AGENT_ENS_NAMES) as [
    keyof typeof AGENT_ENS_NAMES,
    string,
  ][]) {
    const label = agentId;
    const node = ethers.namehash(ensName);
    const targetAddr = agentAddresses[agentId];
    const displayName =
      agentId.charAt(0).toUpperCase() + agentId.slice(1) + " Agent";

    console.log(`${ensName}`);

    // ── Step 1: create subname if it doesn't exist ───────────────────────────
    const existingOwner: string = await registry.owner(node);
    const subnameExists =
      existingOwner !== ethers.ZeroAddress &&
      existingOwner.toLowerCase() !==
        "0x0000000000000000000000000000000000000000";

    if (subnameExists) {
      console.log(`  create   : already exists (owner: ${existingOwner})`);
    } else {
      let tx: ethers.TransactionResponse;
      if (rootIsWrapped) {
        // NameWrapper flow: setSubnodeRecord(parentNode, label, owner, resolver, ttl, fuses, expiry)
        tx = await nameWrapper.setSubnodeRecord(
          rootNode,
          label,
          wallet.address, // subname owner = our wallet
          contracts.publicResolver, // resolver
          0n, // ttl
          0, // fuses (no permissions burned)
          0n, // expiry (inherits parent)
        );
      } else {
        // Plain Registry flow: setSubnodeRecord(node, labelhash, owner, resolver, ttl)
        tx = await registry.setSubnodeRecord(
          rootNode,
          ethers.keccak256(ethers.toUtf8Bytes(label)),
          wallet.address,
          contracts.publicResolver,
          0n,
        );
      }
      await tx.wait();
      console.log(`  create   : subname created  (${tx.hash})`);
    }

    // ── Step 2: look up the live resolver for this node ──────────────────────
    const resolverAddress: string = await registry.resolver(node);
    if (resolverAddress === ethers.ZeroAddress) {
      console.log(
        `  ERROR    : still no resolver after creation — skipping.\n`,
      );
      continue;
    }

    const resolver = new ethers.Contract(
      resolverAddress,
      PUBLIC_RESOLVER_ABI,
      wallet,
    );

    // ── Step 3: set addr record ───────────────────────────────────────────────
    const currentAddr: string = await resolver.addr(node);
    if (currentAddr.toLowerCase() === targetAddr.toLowerCase()) {
      console.log(`  addr     : already ${targetAddr} — skipped`);
    } else {
      const tx = await resolver.setAddr(node, targetAddr);
      await tx.wait();
      console.log(
        `  addr     : ${currentAddr || "(unset)"} → ${targetAddr}  (${tx.hash})`,
      );
    }

    // ── Step 4: set text[name] record ─────────────────────────────────────────
    const currentName: string = await resolver.text(node, "name");
    if (currentName === displayName) {
      console.log(`  name     : already "${displayName}" — skipped`);
    } else {
      const tx = await resolver.setText(node, "name", displayName);
      await tx.wait();
      console.log(
        `  name     : "${currentName || "(unset)"}" → "${displayName}"  (${tx.hash})`,
      );
    }

    // ── Step 5: set text[url] record ──────────────────────────────────────────
    const agentUrl = `${agentBaseUrl}/a2a/agents/${agentId}`;
    const currentUrl: string = await resolver.text(node, "url");
    if (currentUrl === agentUrl) {
      console.log(`  url      : already "${agentUrl}" — skipped`);
    } else {
      const tx = await resolver.setText(node, "url", agentUrl);
      await tx.wait();
      console.log(
        `  url      : "${currentUrl || "(unset)"}" → "${agentUrl}"  (${tx.hash})`,
      );
    }

    console.log();
  }

  console.log("Done.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
