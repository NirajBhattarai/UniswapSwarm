"use client";

import React, { useCallback, useEffect, useState } from "react";

type ManagedWalletData = {
  managedAddress: string;
  balance0g: string;
  hasMinDeposit: boolean;
  ledgerBalance: number | null;
  ledgerLow: boolean | null;
};

type Props = {
  connectedAddress: string;
};

function shortAddress(addr: string): string {
  return `${addr.slice(0, 8)}…${addr.slice(-6)}`;
}

export const ManagedWalletCard: React.FC<Props> = ({ connectedAddress }) => {
  const [data, setData] = useState<ManagedWalletData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Fund ledger state
  const [fundOpen, setFundOpen] = useState(false);
  const [fundAmount, setFundAmount] = useState("5");
  const [funding, setFunding] = useState(false);
  const [fundError, setFundError] = useState<string | null>(null);
  const [fundSuccess, setFundSuccess] = useState<string | null>(null);

  /** Collapse to a single header row; details stay behind the toggle. */
  const [expanded, setExpanded] = useState(true);

  const fetchWallet = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/wallet/managed?address=${encodeURIComponent(connectedAddress)}`,
      );
      const payload = (await res.json()) as ManagedWalletData & {
        error?: string;
      };
      if (!res.ok || payload.error) {
        setError(payload.error ?? `Request failed (${res.status})`);
        return;
      }
      setData(payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setLoading(false);
    }
  }, [connectedAddress]);

  // Fetch on mount and when the connected address changes
  useEffect(() => {
    void fetchWallet();
  }, [fetchWallet]);

  const copyAddress = () => {
    if (!data?.managedAddress) return;
    void navigator.clipboard.writeText(data.managedAddress).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const handleFundLedger = async () => {
    const amount = parseFloat(fundAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setFundError("Enter a positive amount");
      return;
    }
    setFunding(true);
    setFundError(null);
    setFundSuccess(null);
    try {
      const res = await fetch("/api/wallet/fund-ledger", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: connectedAddress, amount }),
      });
      const payload = (await res.json()) as {
        ok?: boolean;
        ledgerBalance?: number;
        ledgerLow?: boolean;
        error?: string;
      };
      if (!res.ok || payload.error) {
        setFundError(payload.error ?? `Failed (${res.status})`);
        return;
      }
      const newBalance = payload.ledgerBalance?.toFixed(4) ?? "?";
      setFundSuccess(`Funded! New ledger balance: ${newBalance} OG`);
      setFundOpen(false);
      // Refresh card data to reflect new balance
      await fetchWallet();
    } catch (err) {
      setFundError(err instanceof Error ? err.message : "Network error");
    } finally {
      setFunding(false);
    }
  };

  if (loading && !data) {
    return (
      <div className="mt-2 animate-pulse rounded-xl border border-slate-200 bg-slate-50/80 p-3">
        <div className="h-3 w-24 rounded bg-slate-200" />
        <div className="mt-2 h-3 w-40 rounded bg-slate-200" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="mt-2 rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">
        <span className="font-semibold">Managed wallet unavailable:</span>{" "}
        {error}
        <button
          type="button"
          onClick={fetchWallet}
          className="ml-2 underline hover:no-underline"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!data) return null;

  const isGreen = data.hasMinDeposit && !data.ledgerLow;

  return (
    <div
      className={`mt-2 rounded-xl border p-3 text-xs transition-colors ${
        isGreen
          ? "border-emerald-300 bg-emerald-50/70"
          : "border-orange-300 bg-orange-50/70"
      }`}
    >
      {/* Header row — status + expand/collapse + refresh */}
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className={`flex min-w-0 flex-1 items-center gap-1.5 text-left font-semibold outline-none focus-visible:ring-2 focus-visible:ring-offset-1 rounded-md ${
            isGreen
              ? "text-emerald-800 focus-visible:ring-emerald-400"
              : "text-orange-800 focus-visible:ring-orange-400"
          }`}
          aria-expanded={expanded}
        >
          <span className="shrink-0 text-[10px] opacity-70" aria-hidden>
            {expanded ? "▼" : "▶"}
          </span>
          <span className="truncate">
            {isGreen ? "✓ 0G Wallet Ready" : "⚠ Action Required"}
          </span>
        </button>
        <button
          type="button"
          onClick={fetchWallet}
          disabled={loading}
          title="Refresh balance"
          className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold transition-colors ${
            isGreen
              ? "bg-emerald-100 text-emerald-700 hover:bg-emerald-200"
              : "bg-orange-100 text-orange-700 hover:bg-orange-200"
          } disabled:opacity-50`}
        >
          {loading ? "…" : "↻ Refresh"}
        </button>
      </div>

      {expanded && (
        <>
      {/* Managed address */}
      <div className="mt-2 flex items-center gap-1.5 font-mono">
        <span className={isGreen ? "text-emerald-900" : "text-orange-900"}>
          {shortAddress(data.managedAddress)}
        </span>
        <button
          type="button"
          onClick={copyAddress}
          title="Copy full address"
          className={`rounded px-1 py-0.5 text-[10px] transition-colors ${
            isGreen
              ? "bg-emerald-100 text-emerald-700 hover:bg-emerald-200"
              : "bg-orange-100 text-orange-700 hover:bg-orange-200"
          }`}
        >
          {copied ? "✓ Copied" : "Copy"}
        </button>
      </div>

      {/* A0GI wallet balance */}
      <div className={`mt-1 ${isGreen ? "text-emerald-700" : "text-orange-700"}`}>
        Wallet: <span className="font-semibold">{data.balance0g} A0GI</span>
      </div>

      {/* 0G Compute ledger balance + Fund Ledger button */}
      {data.ledgerBalance !== null && (
        <div className="mt-0.5 flex items-center justify-between gap-2">
          <div className={data.ledgerLow ? "text-orange-700" : "text-emerald-700"}>
            Compute ledger:{" "}
            <span className="font-semibold">
              {data.ledgerBalance.toFixed(4)} OG
            </span>
            {data.ledgerLow && (
              <span className="ml-1 font-semibold text-orange-600">⚠ low</span>
            )}
          </div>
          {/* Only show Fund Ledger when the managed wallet actually has A0GI to spend */}
          {data.hasMinDeposit && (
            <button
              type="button"
              onClick={() => {
                setFundOpen((v) => !v);
                setFundError(null);
                setFundSuccess(null);
              }}
              className="rounded px-1.5 py-0.5 text-[10px] font-semibold transition-colors bg-sky-100 text-sky-700 hover:bg-sky-200"
            >
              + Fund Ledger
            </button>
          )}
        </div>
      )}

      {/* Ledger balance not yet loaded but wallet is funded — still show the button */}
      {data.ledgerBalance === null && data.hasMinDeposit && (
        <div className="mt-1 flex justify-end">
          <button
            type="button"
            onClick={() => {
              setFundOpen((v) => !v);
              setFundError(null);
              setFundSuccess(null);
            }}
            className="rounded px-1.5 py-0.5 text-[10px] font-semibold transition-colors bg-sky-100 text-sky-700 hover:bg-sky-200"
          >
            + Fund Ledger
          </button>
        </div>
      )}

      {/* Inline fund ledger form */}
      {fundOpen && (
        <div className="mt-2 flex items-center gap-1.5 rounded-lg border border-sky-200 bg-sky-50 px-2 py-1.5">
          <label className="text-[10px] font-semibold text-sky-700 whitespace-nowrap">
            OG amount:
          </label>
          <input
            type="number"
            min="0.1"
            step="1"
            value={fundAmount}
            onChange={(e) => setFundAmount(e.target.value)}
            disabled={funding}
            className="w-16 rounded border border-sky-200 bg-white px-1 py-0.5 text-[11px] text-slate-800 focus:outline-none focus:ring-1 focus:ring-sky-400 disabled:opacity-50"
          />
          <button
            type="button"
            onClick={() => void handleFundLedger()}
            disabled={funding}
            className="rounded bg-sky-600 px-2 py-0.5 text-[10px] font-semibold text-white hover:bg-sky-700 disabled:opacity-50"
          >
            {funding ? "Funding…" : "Confirm"}
          </button>
          <button
            type="button"
            onClick={() => setFundOpen(false)}
            disabled={funding}
            className="rounded px-1 py-0.5 text-[10px] text-sky-600 hover:text-sky-800 disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      )}

      {/* Fund success message */}
      {fundSuccess && (
        <p className="mt-1 text-[10px] font-semibold text-emerald-700">
          ✓ {fundSuccess}
        </p>
      )}

      {/* Fund error message */}
      {fundError && (
        <p className="mt-1 text-[10px] text-rose-600">{fundError}</p>
      )}

      {/* Deposit A0GI prompt */}
      {!data.hasMinDeposit && (
        <p className="mt-2 leading-relaxed text-orange-700">
          Send <span className="font-semibold">≥10 A0GI</span> to the address
          above on the 0G testnet to activate automated trades. Then click{" "}
          <span className="font-semibold">↻ Refresh</span>.
        </p>
      )}

      {/* Ledger topup prompt */}
      {data.hasMinDeposit && data.ledgerLow && (
        <p className="mt-2 leading-relaxed text-orange-700">
          Your 0G Compute ledger is low ({"<"}3 OG). Use the{" "}
          <span className="font-semibold">+ Fund Ledger</span> button above to
          deposit OG from your managed wallet into the compute ledger.
        </p>
      )}
        </>
      )}
    </div>
  );
};

