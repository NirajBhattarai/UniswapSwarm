"use client";

/**
 * SwapIntentForm — HITL form rendered when the orchestrator calls the
 * `gather_swap_intent` action. Mirrors the trip-requirements form from
 * a2a-travel but tailored for swap intent.
 */

import React, { useState } from "react";

interface SwapIntentFormProps {
  args: {
    goal?: string;
    tokenIn?: string;
    tokenOut?: string;
    amountUsd?: number;
    riskLevel?: string;
  };
  respond?: (response: unknown) => void;
}

const RISK_LEVELS = ["Conservative", "Balanced", "Aggressive"] as const;

export const SwapIntentForm: React.FC<SwapIntentFormProps> = ({
  args,
  respond,
}) => {
  const initialRiskLevel: (typeof RISK_LEVELS)[number] = RISK_LEVELS.includes(
    (args?.riskLevel ?? "") as (typeof RISK_LEVELS)[number],
  )
    ? (args!.riskLevel as (typeof RISK_LEVELS)[number])
    : "Balanced";

  // The orchestrator may stream args incrementally — useState's initialiser is
  // only consulted on the first render, so we re-key the form whenever the
  // pre-filled snapshot from the LLM changes.
  const [goal, setGoal] = useState(args?.goal ?? "");
  const [tokenIn, setTokenIn] = useState(args?.tokenIn ?? "USDC");
  const [tokenOut, setTokenOut] = useState(args?.tokenOut ?? "ETH");
  const [amountUsd, setAmountUsd] = useState(args?.amountUsd ?? 100);
  const [riskLevel, setRiskLevel] =
    useState<(typeof RISK_LEVELS)[number]>(initialRiskLevel);
  const [submitted, setSubmitted] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const handleSubmit = () => {
    const next: Record<string, string> = {};
    if (!tokenIn.trim()) next.tokenIn = "Token-in is required";
    if (!tokenOut.trim()) next.tokenOut = "Token-out is required";
    if (tokenIn.trim().toUpperCase() === tokenOut.trim().toUpperCase()) {
      next.tokenOut = "Token-out must differ from token-in";
    }
    if (!amountUsd || amountUsd <= 0)
      next.amountUsd = "Enter a positive amount";
    if (Object.keys(next).length > 0) {
      setErrors(next);
      return;
    }

    setSubmitted(true);
    respond?.({
      goal: goal.trim() || `Swap ~$${amountUsd} of ${tokenIn} into ${tokenOut}`,
      tokenIn: tokenIn.trim().toUpperCase(),
      tokenOut: tokenOut.trim().toUpperCase(),
      amountUsd,
      riskLevel,
    });
  };

  if (submitted) {
    return (
      <div className="my-3 rounded-xl border-2 border-emerald-300 bg-emerald-50/80 p-4">
        <div className="flex items-center gap-3">
          <div className="text-2xl">✓</div>
          <div>
            <h3 className="text-sm font-semibold text-emerald-900">
              Swap intent captured
            </h3>
            <p className="text-xs text-emerald-800">
              Routing {tokenIn.toUpperCase()} → {tokenOut.toUpperCase()} (~$
              {amountUsd}) at {riskLevel} risk to the swarm…
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="my-3 rounded-xl border-2 border-indigo-200 bg-indigo-50/60 p-4 shadow-sm">
      <div className="mb-3 flex items-center gap-2">
        <div className="text-2xl">🎯</div>
        <div>
          <h3 className="text-sm font-semibold text-slate-900">Swap intent</h3>
          <p className="text-xs text-slate-600">
            Confirm the trade goal before I dispatch the swarm.
          </p>
        </div>
      </div>

      <div className="space-y-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-700">
            Goal
          </label>
          <input
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="e.g. swap ~$200 USDC into ETH on Arbitrum"
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-indigo-400 focus:outline-none"
          />
        </div>

        <div className="grid grid-cols-3 gap-2">
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-700">
              Token-in
            </label>
            <input
              value={tokenIn}
              onChange={(e) => setTokenIn(e.target.value.toUpperCase())}
              className={`w-full rounded-lg border bg-white px-3 py-2 text-sm uppercase focus:outline-none ${
                errors.tokenIn
                  ? "border-orange-400"
                  : "border-slate-300 focus:border-indigo-400"
              }`}
            />
            {errors.tokenIn && (
              <p className="mt-1 text-xs text-orange-600">{errors.tokenIn}</p>
            )}
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-700">
              Token-out
            </label>
            <input
              value={tokenOut}
              onChange={(e) => setTokenOut(e.target.value.toUpperCase())}
              className={`w-full rounded-lg border bg-white px-3 py-2 text-sm uppercase focus:outline-none ${
                errors.tokenOut
                  ? "border-orange-400"
                  : "border-slate-300 focus:border-indigo-400"
              }`}
            />
            {errors.tokenOut && (
              <p className="mt-1 text-xs text-orange-600">{errors.tokenOut}</p>
            )}
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-700">
              USD size
            </label>
            <input
              type="number"
              min={1}
              value={amountUsd}
              onChange={(e) => setAmountUsd(Number(e.target.value) || 0)}
              className={`w-full rounded-lg border bg-white px-3 py-2 text-sm focus:outline-none ${
                errors.amountUsd
                  ? "border-orange-400"
                  : "border-slate-300 focus:border-indigo-400"
              }`}
            />
            {errors.amountUsd && (
              <p className="mt-1 text-xs text-orange-600">{errors.amountUsd}</p>
            )}
          </div>
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-slate-700">
            Risk level
          </label>
          <div className="grid grid-cols-3 gap-2">
            {RISK_LEVELS.map((level) => (
              <button
                key={level}
                type="button"
                onClick={() => setRiskLevel(level)}
                className={`rounded-lg border px-3 py-2 text-xs font-semibold transition ${
                  riskLevel === level
                    ? "border-indigo-400 bg-indigo-500 text-white"
                    : "border-slate-300 bg-white text-slate-700 hover:border-indigo-300"
                }`}
              >
                {level}
              </button>
            ))}
          </div>
        </div>
      </div>

      <button
        type="button"
        onClick={handleSubmit}
        className="mt-4 w-full rounded-lg bg-emerald-600 px-3 py-2.5 text-sm font-semibold text-white shadow hover:bg-emerald-700"
      >
        Dispatch the swarm
      </button>
    </div>
  );
};
