/**
 * GET /api/wallet/managed?address=0x…
 *
 * Returns the managed wallet address for a connected user, creating one
 * on first call. Also checks:
 *   - A0GI (native 0G token) balance on the 0G testnet
 *   - 0G Compute ledger balance (via orchestrator's /managed-wallet/:addr/ledger)
 *
 * Response:
 *   { managedAddress, balance0g, hasMinDeposit, ledgerBalance, ledgerLow }
 *
 * The private key is NEVER included in any response.
 */

import { NextRequest, NextResponse } from "next/server";
import { getOrCreateManagedWallet } from "../../../../lib/dynamo-wallets";

const ZG_CHAIN_RPC =
  process.env.ZG_CHAIN_RPC ?? "https://evmrpc-testnet.0g.ai";
const ORCHESTRATOR_URL =
  process.env.ORCHESTRATOR_URL ?? "http://localhost:4000";
const MIN_DEPOSIT_A0GI = BigInt(10) * BigInt(10) ** BigInt(18); // 10 A0GI in wei

/** Validate a checksummed or lowercase Ethereum address. */
function isValidAddress(addr: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(addr);
}

async function fetchA0GIBalance(address: string): Promise<bigint> {
  const res = await fetch(ZG_CHAIN_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getBalance",
      params: [address, "latest"],
    }),
  });
  if (!res.ok) throw new Error(`0G RPC error: HTTP ${res.status}`);
  const data = (await res.json()) as { result?: string; error?: { message?: string } };
  if (data.error) throw new Error(data.error.message ?? "RPC error");
  return BigInt(data.result ?? "0x0");
}

async function fetchLedgerBalance(
  connectedAddress: string,
): Promise<{ ledgerBalance: number | null; ledgerLow: boolean | null }> {
  try {
    const res = await fetch(
      `${ORCHESTRATOR_URL}/managed-wallet/${encodeURIComponent(connectedAddress)}/ledger`,
      { cache: "no-store" },
    );
    if (!res.ok) return { ledgerBalance: null, ledgerLow: null };
    const data = (await res.json()) as {
      ledgerBalance?: number | null;
      ledgerLow?: boolean | null;
    };
    return {
      ledgerBalance: data.ledgerBalance ?? null,
      ledgerLow: data.ledgerLow ?? null,
    };
  } catch {
    return { ledgerBalance: null, ledgerLow: null };
  }
}

export async function GET(request: NextRequest) {
  const address = request.nextUrl.searchParams.get("address")?.trim() ?? "";

  if (!isValidAddress(address)) {
    return NextResponse.json(
      { error: "Invalid Ethereum address" },
      { status: 400 },
    );
  }

  try {
    // Get or create the managed wallet record (private key stays in DynamoDB)
    const record = await getOrCreateManagedWallet(address);

    // Fetch A0GI balance + ledger balance in parallel
    const [balanceWeiResult, ledgerResult] = await Promise.allSettled([
      fetchA0GIBalance(record.managedAddress),
      fetchLedgerBalance(address),
    ]);

    const balanceWei =
      balanceWeiResult.status === "fulfilled" ? balanceWeiResult.value : BigInt(0);
    const { ledgerBalance, ledgerLow } =
      ledgerResult.status === "fulfilled"
        ? ledgerResult.value
        : { ledgerBalance: null, ledgerLow: null };

    const balanceA0GI = Number(balanceWei) / 1e18;
    const balance0g = balanceA0GI.toFixed(4);
    const hasMinDeposit = balanceWei >= MIN_DEPOSIT_A0GI;

    return NextResponse.json({
      managedAddress: record.managedAddress,
      balance0g,
      hasMinDeposit,
      ledgerBalance,
      ledgerLow,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const status =
      message.includes("DYNAMODB_") ||
      message.includes("WALLET_ENCRYPTION_KEY") ||
      message.includes("AWS_")
        ? 503
        : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
