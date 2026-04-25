#!/usr/bin/env tsx
/**
 * fund-ledger.ts
 * Checks the 0G Compute ledger balance and tops it up automatically.
 * Logic:
 *   - If balance >= 5  → already well-funded, skip deposit
 *   - If balance ∈ [1,5) → deposit (5 - balance) to top up to 5
 *   - If balance < 1   → deposit (balance_available - 1) from wallet,
 *                         capped to bring ledger to 5 total
 *                         (keeps 1 OG in wallet as reserve)
 */

import "dotenv/config";
import { createZGComputeNetworkBroker } from "@0glabs/0g-serving-broker";
import { ethers } from "ethers";
import { getConfig } from "@swarm/shared";

const TARGET = 5; // desired ledger balance in OG
const RESERVE = 1; // minimum OG to keep in wallet

async function main() {
  const cfg = getConfig();
  const provider = new ethers.JsonRpcProvider(cfg.ZG_CHAIN_RPC);
  const wallet = new ethers.Wallet(cfg.ZG_PRIVATE_KEY, provider);

  console.log(`Wallet address : ${wallet.address}`);

  // ── Wallet balance ──────────────────────────────────────────────────────────
  const walletBalanceWei = await provider.getBalance(wallet.address);
  const walletBalance = parseFloat(ethers.formatEther(walletBalanceWei));
  console.log(`Wallet balance : ${walletBalance.toFixed(6)} OG`);

  if (walletBalance <= RESERVE) {
    console.error(
      `ERROR: Wallet balance (${walletBalance.toFixed(6)} OG) is at or below the ` +
        `${RESERVE} OG reserve. Cannot deposit. Please top up your wallet first.`,
    );
    process.exit(1);
  }

  // ── Connect broker ──────────────────────────────────────────────────────────
  const broker = await createZGComputeNetworkBroker(wallet);

  // ── Ledger balance ──────────────────────────────────────────────────────────
  let ledgerBalance = 0;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ledger = await (broker.ledger.getLedger() as Promise<any>);
    // The ledger object shape varies by SDK version — try common field names
    const raw: unknown =
      ledger?.balance ??
      ledger?.totalBalance ??
      ledger?.availableBalance ??
      ledger?.[0] ??
      0;
    ledgerBalance =
      typeof raw === "bigint"
        ? parseFloat(ethers.formatEther(raw))
        : typeof raw === "string"
          ? parseFloat(ethers.formatEther(BigInt(raw)))
          : Number(raw);
    console.log(`Ledger balance : ${ledgerBalance.toFixed(6)} OG`);
  } catch (err) {
    console.log(`Ledger balance : 0 OG (no ledger yet — will create one)`);
    console.log(`  (${err instanceof Error ? err.message : String(err)})`);
    ledgerBalance = 0;
  }

  // ── Deposit decision ────────────────────────────────────────────────────────
  if (ledgerBalance >= TARGET) {
    console.log(
      `✅ Ledger already has ${ledgerBalance.toFixed(6)} OG — no deposit needed.`,
    );
    return;
  }

  const shortfall = TARGET - ledgerBalance;
  const maxCanDeposit = walletBalance - RESERVE;
  const depositAmount = Math.min(shortfall, maxCanDeposit);

  if (depositAmount <= 0) {
    console.error(
      `ERROR: Cannot deposit. Wallet only has ${walletBalance.toFixed(6)} OG ` +
        `(need at least ${RESERVE + shortfall} OG to reach target + keep reserve).`,
    );
    process.exit(1);
  }

  const roundedDeposit = Math.floor(depositAmount * 1e6) / 1e6; // 6 dp precision
  console.log(
    `\nDepositing ${roundedDeposit} OG into ledger ` +
      `(target=${TARGET}, current=${ledgerBalance.toFixed(6)}, shortfall=${shortfall.toFixed(6)})…`,
  );

  await broker.ledger.depositFund(roundedDeposit);

  console.log(
    `✅ Deposit complete — ledger should now have ~${(ledgerBalance + roundedDeposit).toFixed(6)} OG`,
  );
  console.log(
    `   Remaining wallet reserve: ~${(walletBalance - roundedDeposit).toFixed(6)} OG`,
  );
}

main().catch((err) => {
  console.error("FATAL:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
