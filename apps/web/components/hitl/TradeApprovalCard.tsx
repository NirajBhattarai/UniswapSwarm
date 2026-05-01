"use client";

/**
 * TradeApprovalCard — HITL component rendered when the orchestrator calls
 * the `request_trade_approval` action. Mirrors the BudgetApprovalCard
 * pattern from CopilotKit/a2a-travel.
 */

import React from "react";
import type { CritiqueData, StrategyData } from "../types";

interface TradeApprovalCardProps {
  strategy: StrategyData | null;
  critique: CritiqueData | null;
  isApproved: boolean;
  isRejected: boolean;
  isSubmitting?: boolean;
  txHash?: string | null;
  error?: string | null;
  onApprove: () => void;
  onReject: () => void;
}

const formatUsd = (value: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);

export const TradeApprovalCard: React.FC<TradeApprovalCardProps> = ({
  strategy,
  critique,
  isApproved,
  isRejected,
  isSubmitting = false,
  txHash = null,
  error = null,
  onApprove,
  onReject,
}) => {
  if (!strategy) {
    return (
      <div className="my-3 rounded-xl border border-slate-200 bg-slate-50 p-4 text-xs text-slate-600">
        Loading swap proposal…
      </div>
    );
  }

  const pair =
    strategy.tokenInSymbol && strategy.tokenOutSymbol
      ? `${strategy.tokenInSymbol} → ${strategy.tokenOutSymbol}`
      : "Pair pending";

  return (
    <div className="my-3 rounded-xl border-2 border-violet-300 bg-violet-50/60 p-4 shadow-sm">
      <div className="mb-3 flex items-center gap-2">
        <div className="text-2xl">🚦</div>
        <div>
          <h3 className="text-sm font-semibold text-slate-900">
            Trade approval required
          </h3>
          <p className="text-xs text-slate-600">
            Review the swarm&apos;s proposed swap before the executor signs
            anything.
          </p>
        </div>
      </div>

      <div className="mb-3 rounded-lg border border-slate-200 bg-white p-3">
        <div className="flex items-center justify-between text-sm">
          <span className="font-medium text-slate-600">Swap</span>
          <span className="text-base font-semibold text-slate-900">{pair}</span>
        </div>

        {strategy.amountInUsd !== undefined && (
          <div className="mt-1 flex items-center justify-between text-xs">
            <span className="text-slate-500">Size</span>
            <span className="font-semibold text-slate-800">
              {formatUsd(strategy.amountInUsd)}
            </span>
          </div>
        )}

        {strategy.slippagePct !== undefined && (
          <div className="mt-1 flex items-center justify-between text-xs">
            <span className="text-slate-500">Slippage</span>
            <span className="font-semibold text-slate-800">
              {strategy.slippagePct}%
            </span>
          </div>
        )}

        {strategy.feeTier !== undefined && (
          <div className="mt-1 flex items-center justify-between text-xs">
            <span className="text-slate-500">Pool fee tier</span>
            <span className="font-semibold text-slate-800">
              {strategy.feeTier} bps
            </span>
          </div>
        )}

        {strategy.chain && (
          <div className="mt-1 flex items-center justify-between text-xs">
            <span className="text-slate-500">Chain</span>
            <span className="font-semibold text-slate-800">
              {strategy.chain}
            </span>
          </div>
        )}

        {strategy.rationale && (
          <p className="mt-2 border-t border-slate-100 pt-2 text-xs text-slate-600">
            {strategy.rationale}
          </p>
        )}
      </div>

      {critique && (
        <div
          className={`mb-3 rounded-lg border px-3 py-2 ${
            critique.approved
              ? "border-emerald-300 bg-emerald-50 text-emerald-800"
              : "border-orange-300 bg-orange-50 text-orange-800"
          }`}
        >
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold uppercase tracking-wide">
              Critic: {critique.approved ? "approved" : "needs revision"}
            </span>
            {typeof critique.confidence === "number" && (
              <span>confidence {Math.round(critique.confidence ?? 0)}%</span>
            )}
          </div>
          {critique.notes && <p className="mt-1 text-xs">{critique.notes}</p>}
          {critique.issues && critique.issues.length > 0 && (
            <ul className="mt-1 list-disc pl-4 text-xs">
              {critique.issues.map((issue, idx) => (
                <li key={`issue-${idx}`}>{issue}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {isRejected && (
        <div className="mb-3 rounded-lg border border-orange-300 bg-orange-50 p-2 text-xs text-orange-800">
          ❌ You rejected the swap. The orchestrator will not execute.
        </div>
      )}
      {isSubmitting && !txHash && (
        <div className="mb-3 flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 p-2 text-xs text-blue-800">
          <svg
            className="h-3.5 w-3.5 animate-spin text-blue-600"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8v8z"
            />
          </svg>
          <span>Sending transaction…</span>
        </div>
      )}
      {txHash && (
        <div
          className={`mb-3 rounded-lg border p-2 text-xs ${
            isApproved
              ? "border-emerald-300 bg-emerald-50 text-emerald-800"
              : "border-blue-200 bg-blue-50 text-blue-800"
          }`}
        >
          <div className="flex items-center gap-1">
            {isSubmitting ? (
              <svg
                className="h-3 w-3 animate-spin"
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8v8z"
                />
              </svg>
            ) : (
              <span>✅</span>
            )}
            <span className="font-semibold">
              {isSubmitting ? "Confirming…" : "Transaction confirmed"}
            </span>
          </div>
          <div className="mt-1 flex items-center gap-1 font-mono">
            <span className="truncate">{txHash}</span>
            <a
              href={
                txHash.length === 66
                  ? `https://etherscan.io/tx/${txHash}`
                  : `https://etherscan.io/search?q=${txHash}`
              }
              target="_blank"
              rel="noopener noreferrer"
              className="shrink-0 underline hover:no-underline"
            >
              ↗
            </a>
          </div>
        </div>
      )}
      {error && (
        <div className="mb-3 rounded-lg border border-rose-300 bg-rose-50 p-2 text-xs text-rose-800">
          ⚠ {error}
        </div>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onApprove}
          disabled={isApproved || isRejected || isSubmitting}
          className={`flex-1 rounded-lg py-2 text-xs font-semibold ${
            isApproved
              ? "cursor-not-allowed bg-emerald-600 text-white"
              : isRejected
                ? "cursor-not-allowed bg-slate-300 text-slate-600"
                : isSubmitting
                  ? "cursor-not-allowed bg-emerald-400 text-white"
                  : "bg-emerald-600 text-white hover:bg-emerald-700"
          }`}
        >
          {isApproved
            ? "✓ Approved"
            : isSubmitting && txHash
              ? "Confirming…"
              : isSubmitting
                ? "Sending transaction…"
                : "Approve & execute"}
        </button>
        <button
          type="button"
          onClick={onReject}
          disabled={isApproved || isRejected || isSubmitting}
          className={`flex-1 rounded-lg py-2 text-xs font-semibold ${
            isRejected
              ? "cursor-not-allowed bg-orange-500 text-white"
              : isApproved
                ? "cursor-not-allowed bg-slate-300 text-slate-600"
                : isSubmitting
                  ? "cursor-not-allowed bg-slate-300 text-slate-600"
                  : "bg-orange-500 text-white hover:bg-orange-600"
          }`}
        >
          {isRejected ? "✗ Rejected" : "Reject"}
        </button>
      </div>
    </div>
  );
};
