/**
 * POST /api/wallet/fund-ledger
 * Body: { address: string, amount: number }
 *
 * Proxies to the orchestrator's POST /managed-wallet/:address/fund-ledger.
 * The managed wallet's private key never leaves the server — only the
 * connected wallet address + desired amount are sent from the browser.
 */

import { NextRequest, NextResponse } from "next/server";

const ORCHESTRATOR_URL =
  process.env.ORCHESTRATOR_URL ?? "http://localhost:4000";

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

  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return NextResponse.json(
      { error: "amount must be a positive number (OG tokens)" },
      { status: 400 },
    );
  }

  try {
    const res = await fetch(
      `${ORCHESTRATOR_URL}/managed-wallet/${encodeURIComponent(address)}/fund-ledger`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount }),
      },
    );

    const data = (await res.json()) as {
      ok?: boolean;
      ledgerBalance?: number;
      ledgerLow?: boolean;
      error?: string;
    };

    if (!res.ok || data.error) {
      return NextResponse.json(
        { error: data.error ?? `Orchestrator error (${res.status})` },
        { status: res.status >= 400 ? res.status : 500 },
      );
    }

    return NextResponse.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
