#!/usr/bin/env tsx
/**
 * approve-ens-delegate.ts
 *
 * ONE-TIME setup: approves a "records" wallet as a delegate on the ENS
 * Public Resolver for every Uniswap Swarm agent subdomain.
 *
 * After this runs you NEVER need the owner key again for record updates.
 * Use ENS_RECORDS_PRIVATE_KEY (the delegate) with setup-ens instead.
 *
 * Usage:
 *   pnpm approve-ens-delegate
 *
 * Required env vars:
 *   ETH_RPC_URL           — Ethereum mainnet JSON-RPC URL
 *   ENS_OWNER_PRIVATE_KEY — Private key of the wallet that owns uniswapswarm.eth
 *   ENS_DELEGATE_ADDRESS  — Address of the hot wallet that will set records
 */

import "dotenv/config";
import { ethers } from "ethers";
import { ENS_CONTRACTS_BY_CHAIN, AGENT_ENS_NAMES } from "@swarm/shared";

// Public Resolver v3 supports per-node delegation
const PUBLIC_RESOLVER_ABI = [
  "function approve(bytes32 node, address delegate, bool approved)",
  "function isApprovedFor(address owner, bytes32 node, address delegate) view returns (bool)",
] as const;

async function main() {
  const rpcUrl = process.env["ENS_RPC_URL"] ?? process.env["ETH_RPC_URL"];
  const privateKey = process.env["ENS_OWNER_PRIVATE_KEY"];
  const delegateAddress = process.env["ENS_DELEGATE_ADDRESS"];

  if (!rpcUrl || !privateKey || !delegateAddress) {
    console.error(
      "ERROR: ETH_RPC_URL, ENS_OWNER_PRIVATE_KEY, and ENS_DELEGATE_ADDRESS must all be set.",
    );
    process.exit(1);
  }

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
  const owner = new ethers.Wallet(privateKey, provider);

  console.log(`Network  : chainId ${chainIdNum}`);
  console.log(`Owner    : ${owner.address}`);
  console.log(`Delegate : ${delegateAddress}\n`);

  const resolver = new ethers.Contract(
    contracts.publicResolver,
    PUBLIC_RESOLVER_ABI,
    owner,
  );

  for (const [agentId, ensName] of Object.entries(AGENT_ENS_NAMES)) {
    const node = ethers.namehash(ensName);

    const alreadyApproved: boolean = await resolver.isApprovedFor(
      owner.address,
      node,
      delegateAddress,
    );

    if (alreadyApproved) {
      console.log(`  [skip] ${ensName} — delegate already approved`);
      continue;
    }

    const tx = await resolver.approve(node, delegateAddress, true);
    await tx.wait();
    console.log(`  [ok]   ${ensName} — approved  (${tx.hash})`);
  }

  console.log(
    "\nDone. You can now run setup-ens with ENS_RECORDS_PRIVATE_KEY.",
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
