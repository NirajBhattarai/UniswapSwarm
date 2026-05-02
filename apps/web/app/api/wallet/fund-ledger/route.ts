/**
 * POST /api/wallet/fund-ledger
 * Body: { address: string, amount: number }
 *
 * Funds the 0G Compute ledger for a managed wallet by:
 * 1. Fetching the managed wallet's private key from DynamoDB (using AWS credentials from .env)
 * 2. Creating a ZGCompute instance locally
 * 3. Calling fundLedger() directly (no orchestrator needed)
 *
 * This is independent of the orchestrator service — it can fund even when
 * the orchestrator is offline, as long as AWS credentials are available.
 */

import { NextRequest, NextResponse } from "next/server";
import { getManagedPrivateKey } from "@swarm/shared";

function isValidAddress(addr: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(addr);
}

export async function POST(request: NextRequest) {
  let body: { address?: unknown; amount?: unknown };
  try {
    body = (await request.json()) as { address?: unknown; amount?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const address = typeof body.address === "string" ? body.address.trim() : "";
  if (!isValidAddress(address)) {
    return NextResponse.json(
      { error: "Invalid Ethereum address" },
      { status: 400 },
    );
  }

  let amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return NextResponse.json(
      { error: "amount must be a positive number (OG tokens)" },
      { status: 400 },
    );
  }

  try {
    // Fetch managed wallet private key from DynamoDB
    console.log(`[Fund-Ledger] Fetching managed wallet for ${address}`);
    const privateKey = await getManagedPrivateKey(address);
    if (!privateKey) {
      return NextResponse.json(
        {
          error: `No managed wallet found for ${address}. Ensure it's registered in DynamoDB.`,
        },
        { status: 404 },
      );
    }

    // Import ZGCompute and create instance
    const { ZGCompute } = await import("@swarm/compute");
    const compute = new ZGCompute(privateKey);

    // Ensure minimum 5 OG is funded
    if (amount < 5) {
      console.warn(
        `[Fund-Ledger] Fund request for ${amount} OG is below recommended 5 OG. Bumping to 5 OG.`,
      );
      amount = 5;
    }

    // Fund the ledger directly
    console.log(
      `[Fund-Ledger] Funding ledger for ${address} with ${amount} OG`,
    );
    await compute.fundLedger(amount);

    // Get updated balance
    const ledgerBalance = await compute.getLedgerBalance();
    console.log(
      `[Fund-Ledger] Successfully funded ${address}: +${amount} OG, new balance=${ledgerBalance.toFixed(4)} OG`,
    );

    return NextResponse.json({
      ok: true,
      ledgerBalance,
      ledgerLow: ledgerBalance < 5,
      fundedAmount: amount,
      note:
        ledgerBalance >= 5
          ? "Sufficient balance for provider sub-account auto-funding."
          : `Balance is ${ledgerBalance.toFixed(4)} OG. For provider sub-account initialization, 5+ OG recommended.`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Fund-Ledger] Error: ${message}`);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
