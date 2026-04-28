"use client";

/**
 * SwarmDataCards — sidebar that surfaces structured JSON returned by each
 * Uniswap Swarm A2A agent (researcher, planner, risk, strategy, critic,
 * executor). Mirrors the right-rail "ItineraryCard / BudgetBreakdown / etc."
 * pattern from CopilotKit/a2a-travel.
 */

import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { BrowserProvider, ethers } from "ethers";
import {
  useAppKit,
  useAppKitAccount,
  useAppKitProvider,
} from "@reown/appkit/react";
import {
  SWARM_PIPELINE_NODE_IDS,
  SWARM_PIPELINE_STAGE_ORDER,
} from "../pipeline/swarm-pipeline-ids";
import type {
  AgentStorageWrite,
  CritiqueData,
  ExecutionData,
  PlanData,
  ResearchData,
  RiskData,
  RiskFlag,
  RiskFlagSeverity,
  StrategyData,
  SwarmAggregateState,
} from "../types";

interface SwarmDataCardsProps {
  state: SwarmAggregateState;
  /** When set (e.g. from the pipeline graph), the matching section is highlighted. */
  selectedId?: string | null;
}

const SectionWrap: React.FC<{
  sectionId: string;
  selected: boolean;
  children: React.ReactNode;
}> = ({ sectionId, selected, children }) => (
  <div
    id={`swarm-section-${sectionId}`}
    className={
      selected
        ? "rounded-[14px] ring-2 ring-[#85e0ce] ring-offset-2 ring-offset-white/50"
        : undefined
    }
  >
    {children}
  </div>
);

const formatUsd = (value?: number) =>
  typeof value === "number"
    ? new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
      }).format(value)
    : "—";

// ── Per-agent storage footer ──────────────────────────────────────────────────

const formatHashShortInline = (hash: string): string => {
  if (hash.length <= 14) return hash;
  return `${hash.slice(0, 8)}…${hash.slice(-4)}`;
};

const formatBytesInline = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
};

/**
 * Shows the 0G Storage writes that this agent produced — rendered at the
 * bottom of every per-agent pipeline card so the user can see the storage
 * location without leaving the flow canvas.
 */
const StorageFooter: React.FC<{ writes: AgentStorageWrite[] }> = ({
  writes,
}) => {
  if (writes.length === 0) return null;
  return (
    <div className="mt-2 border-t border-dashed border-cyan-200 pt-2">
      <p className="mb-1 text-[9px] font-semibold uppercase tracking-widest text-cyan-600">
        🗄️ 0G Storage
      </p>
      <ul className="space-y-1">
        {writes.map((entry, idx) => {
          const isLocal = entry.hash.startsWith("local:");
          return (
            <li
              key={`${entry.key}-${entry.hash}-${idx}`}
              className={`flex items-center justify-between gap-1.5 rounded-md border px-2 py-1 font-mono text-[10px] ${
                isLocal
                  ? "border-amber-200 bg-amber-50 text-amber-800"
                  : "border-cyan-200 bg-cyan-50 text-cyan-800"
              }`}
            >
              <span className="truncate font-semibold not-italic">
                {entry.key}
              </span>
              <span className="shrink-0 flex items-center gap-1 opacity-80">
                <span>→</span>
                <span>{formatHashShortInline(entry.hash)}</span>
                <span className="opacity-60">·</span>
                <span>{formatBytesInline(entry.sizeBytes ?? 0)}</span>
                <span
                  className={`ml-1 rounded-full px-1.5 py-0.5 text-[9px] font-semibold ${
                    isLocal
                      ? "bg-amber-200 text-amber-800"
                      : "bg-cyan-200 text-cyan-800"
                  }`}
                >
                  {isLocal ? "local" : "0G ✓"}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
};

/**
 * Renders a single pipeline stage (used inside React Flow card nodes and in the
 * optional stacked `SwarmDataCards` list).
 */
export const SwarmPipelineStageBody: React.FC<{
  sectionId: string;
  state: SwarmAggregateState;
}> = ({ sectionId, state }) => {
  const {
    research,
    plan,
    risk,
    strategy,
    critique,
    execution,
    request,
    storage,
  } = state;

  // Writes belonging to this specific agent (empty for userIntent / storage nodes).
  const agentWrites =
    sectionId === SWARM_PIPELINE_NODE_IDS.userIntent ||
    sectionId === SWARM_PIPELINE_NODE_IDS.storage
      ? []
      : (storage ?? []).filter((w) => w.agentId === sectionId);

  switch (sectionId) {
    case SWARM_PIPELINE_NODE_IDS.userIntent:
      return (
        <div className="rounded-xl border border-slate-200 bg-white/90 p-3 shadow-sm">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
            User intent
          </p>
          <p className="mt-1 text-sm text-slate-800">
            {request ?? "Send a message to the swarm to get started."}
          </p>
        </div>
      );
    case SWARM_PIPELINE_NODE_IDS.researcher:
      return (
        <>
          <ResearchCard data={research} />
          <StorageFooter writes={agentWrites} />
        </>
      );
    case SWARM_PIPELINE_NODE_IDS.planner:
      return (
        <>
          <PlanCard data={plan} />
          <StorageFooter writes={agentWrites} />
        </>
      );
    case SWARM_PIPELINE_NODE_IDS.risk:
      return (
        <>
          <RiskCard data={risk} />
          <StorageFooter writes={agentWrites} />
        </>
      );
    case SWARM_PIPELINE_NODE_IDS.strategy:
      return (
        <>
          <StrategyCard data={strategy} />
          <StorageFooter writes={agentWrites} />
        </>
      );
    case SWARM_PIPELINE_NODE_IDS.critic:
      return (
        <>
          <CritiqueCard data={critique} />
          <StorageFooter writes={agentWrites} />
        </>
      );
    case SWARM_PIPELINE_NODE_IDS.executor:
      return (
        <>
          <ExecutionCard data={execution} strategy={strategy} />
          <StorageFooter writes={agentWrites} />
        </>
      );
    case SWARM_PIPELINE_NODE_IDS.storage:
      return <StorageAuditCard writes={storage} />;
    default:
      return null;
  }
};

export const SwarmDataCards: React.FC<SwarmDataCardsProps> = ({
  state,
  selectedId = null,
}) => {
  return (
    <div className="space-y-3">
      {SWARM_PIPELINE_STAGE_ORDER.map((sectionId) => (
        <SectionWrap
          key={sectionId}
          sectionId={sectionId}
          selected={selectedId === sectionId}
        >
          <SwarmPipelineStageBody sectionId={sectionId} state={state} />
        </SectionWrap>
      ))}
    </div>
  );
};

// ── Per-agent cards ─────────────────────────────────────────────────────────

const Empty: React.FC<{ label: string }> = ({ label }) => (
  <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50/60 p-3 text-xs text-slate-500">
    {label}
  </div>
);

const SectionHeader: React.FC<{
  icon: string;
  title: string;
  badge?: string;
  tone?: string;
}> = ({ icon, title, badge, tone = "bg-slate-100 text-slate-600" }) => (
  <div className="mb-2 flex items-center justify-between">
    <div className="flex items-center gap-2">
      <span className="text-base">{icon}</span>
      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-600">
        {title}
      </p>
    </div>
    {badge && (
      <span
        className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${tone}`}
      >
        {badge}
      </span>
    )}
  </div>
);

const ResearchCard: React.FC<{ data?: ResearchData }> = ({ data }) => {
  if (!data) {
    return (
      <div className="rounded-xl border border-emerald-100 bg-emerald-50/40 p-3">
        <SectionHeader icon="🔎" title="Researcher" />
        <Empty label="Awaiting research candidates from the Researcher Agent." />
      </div>
    );
  }
  const candidates = data.candidates ?? [];

  return (
    <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-3 shadow-sm">
      <SectionHeader
        icon="🔎"
        title="Researcher"
        badge={`${candidates.length} candidates`}
        tone="bg-emerald-100 text-emerald-700"
      />
      {data.marketSummary && (
        <p className="mb-2 text-xs text-slate-700">{data.marketSummary}</p>
      )}
      {candidates.length === 0 ? (
        <Empty label="No candidates returned." />
      ) : (
        <ul className="space-y-1.5">
          {candidates.slice(0, 5).map((cand, idx) => (
            <li
              key={`cand-${idx}`}
              className="flex items-center justify-between rounded-md bg-white/70 px-2 py-1.5 text-xs"
            >
              <span className="font-semibold text-slate-800">
                {cand.symbol ?? cand.name ?? "Unknown"}
              </span>
              <span className="text-slate-500">
                {typeof cand.score === "number"
                  ? `score ${cand.score.toFixed(2)}`
                  : (cand.chain ?? "—")}
              </span>
            </li>
          ))}
        </ul>
      )}
      {data.dataSource && (
        <p className="mt-2 text-[10px] uppercase tracking-wide text-emerald-700">
          source: {data.dataSource}
        </p>
      )}
    </div>
  );
};

const PlanCard: React.FC<{ data?: PlanData }> = ({ data }) => {
  if (!data) {
    return (
      <div className="rounded-xl border border-blue-100 bg-blue-50/40 p-3">
        <SectionHeader icon="🗺️" title="Planner" />
        <Empty label="Planner has not produced a TradePlan yet." />
      </div>
    );
  }
  const tasks = data.tasks ?? [];
  return (
    <div className="rounded-xl border border-blue-200 bg-blue-50/60 p-3 shadow-sm">
      <SectionHeader
        icon="🗺️"
        title="Planner"
        badge={`${tasks.length} tasks`}
        tone="bg-blue-100 text-blue-700"
      />
      {data.strategy && (
        <p className="mb-2 text-xs text-slate-700">
          <span className="font-semibold">Strategy:</span> {data.strategy}
        </p>
      )}
      {tasks.length === 0 ? (
        <Empty label="No tasks defined." />
      ) : (
        <ol className="space-y-1.5">
          {tasks.slice(0, 6).map((task, idx) => {
            // Backend emits `{ agentId, action }` (canonical AgentTask shape);
            // older payloads used `{ agent, description }` so we accept both.
            const agentLabel =
              task.agentId ?? task.agent ?? task.id ?? `step ${idx + 1}`;
            const actionLabel = task.action ?? task.description;
            return (
              <li
                key={`task-${idx}`}
                className="rounded-md bg-white/80 px-2 py-1.5 text-xs text-slate-800"
              >
                <div className="flex items-baseline gap-2">
                  <span className="text-[10px] font-bold text-blue-500 tabular-nums">
                    {idx + 1}.
                  </span>
                  <span className="font-semibold capitalize text-blue-700">
                    {agentLabel}
                  </span>
                </div>
                {actionLabel && (
                  <p className="mt-0.5 text-[11px] leading-snug text-slate-700">
                    {actionLabel}
                  </p>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
};

// ── Risk helpers ────────────────────────────────────────────────────────────

const SEVERITY_TONE: Record<RiskFlagSeverity, string> = {
  low: "bg-slate-100 text-slate-600 border-slate-200",
  medium: "bg-amber-100 text-amber-700 border-amber-200",
  high: "bg-orange-100 text-orange-700 border-orange-200",
  critical: "bg-rose-100 text-rose-700 border-rose-200",
};

const SEVERITY_RANK: Record<RiskFlagSeverity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

/**
 * Normalise the heterogeneous `flags` shape (RiskFlag[] | string[]) into a
 * uniform array of objects we can render.
 */
const normaliseFlags = (
  flags: RiskFlag[] | string[] | undefined,
): { type: string; severity: RiskFlagSeverity; detail: string }[] => {
  if (!flags || flags.length === 0) return [];
  return flags.map((f) => {
    if (typeof f === "string") {
      return {
        type: "flag",
        severity: "medium" as RiskFlagSeverity,
        detail: f,
      };
    }
    return {
      type: f.type ?? "flag",
      severity: (f.severity ?? "medium") as RiskFlagSeverity,
      detail: f.detail ?? "",
    };
  });
};

const formatFlagType = (type: string): string =>
  type.replace(/_/g, " ").toLowerCase();

const URL_REGEX = /(https?:\/\/[^\s]+)/g;

const renderWithLinks = (text: string): React.ReactNode[] => {
  const parts = text.split(URL_REGEX);
  return parts.map((part, idx) => {
    if (/^https?:\/\//.test(part)) {
      return (
        <a
          key={`url-${idx}-${part}`}
          href={part}
          target="_blank"
          rel="noopener noreferrer"
          className="underline decoration-dotted underline-offset-2 hover:decoration-solid"
        >
          {part}
        </a>
      );
    }
    return <React.Fragment key={`txt-${idx}`}>{part}</React.Fragment>;
  });
};

const RiskCard: React.FC<{ data?: RiskData }> = ({ data }) => {
  if (!data) {
    return (
      <div className="rounded-xl border border-orange-100 bg-orange-50/40 p-3">
        <SectionHeader icon="🛡️" title="Risk" />
        <Empty label="Risk has not scored any candidates yet." />
      </div>
    );
  }
  const passed = data.filter((entry) => entry.passed).length;
  return (
    <div className="rounded-xl border border-orange-200 bg-orange-50/60 p-3 shadow-sm">
      <SectionHeader
        icon="🛡️"
        title="Risk"
        badge={`${passed}/${data.length} passed`}
        tone="bg-orange-100 text-orange-700"
      />
      {data.length === 0 ? (
        <Empty label="No assessments." />
      ) : (
        <ul className="space-y-2">
          {data.slice(0, 6).map((entry, idx) => {
            // Backend emits `{ symbol, score, flags, recommendation }`; legacy
            // payloads used `{ candidate, riskScore, reason }` — accept both.
            const symbol = entry.symbol ?? entry.candidate ?? "—";
            const score = entry.score ?? entry.riskScore;
            const reason = entry.recommendation ?? entry.reason;
            const flags = normaliseFlags(entry.flags).sort(
              (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity],
            );
            const topFlags = flags.slice(0, 3);
            const hasMoreFlags = flags.length > topFlags.length;

            return (
              <li
                key={`risk-${idx}`}
                className={`rounded-md border px-2 py-1.5 text-xs ${
                  entry.passed
                    ? "border-emerald-200 bg-white/85"
                    : "border-rose-200 bg-rose-50/60"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-baseline gap-2 min-w-0">
                    <span className="font-semibold text-slate-800 truncate">
                      {symbol}
                    </span>
                    {typeof score === "number" && (
                      <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-slate-600">
                        {score}/100
                      </span>
                    )}
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                      entry.passed
                        ? "bg-emerald-100 text-emerald-700"
                        : "bg-rose-100 text-rose-700"
                    }`}
                  >
                    {entry.passed ? "passed" : "blocked"}
                  </span>
                </div>

                {topFlags.length > 0 && (
                  <ul className="mt-1.5 space-y-1">
                    {topFlags.map((flag, fIdx) => (
                      <li
                        key={`flag-${idx}-${fIdx}`}
                        className={`rounded border px-1.5 py-1 text-[10.5px] leading-snug ${
                          SEVERITY_TONE[flag.severity]
                        }`}
                        title={flag.detail || undefined}
                      >
                        <span className="font-semibold uppercase tracking-wide">
                          {flag.severity}
                        </span>
                        <span className="mx-1 opacity-60">·</span>
                        <span className="font-medium">
                          {formatFlagType(flag.type)}
                        </span>
                        {flag.detail && (
                          <span className="mt-0.5 block text-slate-700">
                            {renderWithLinks(flag.detail)}
                          </span>
                        )}
                      </li>
                    ))}
                    {hasMoreFlags && (
                      <li className="text-[10px] text-slate-500">
                        +{flags.length - topFlags.length} more flag
                        {flags.length - topFlags.length === 1 ? "" : "s"}
                      </li>
                    )}
                  </ul>
                )}

                {reason && (
                  <p className="mt-1 text-[11px] leading-snug text-slate-600">
                    {renderWithLinks(reason)}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};

const StrategyCard: React.FC<{ data?: StrategyData }> = ({ data }) => {
  if (!data) {
    return (
      <div className="rounded-xl border border-violet-100 bg-violet-50/40 p-3">
        <SectionHeader icon="🎯" title="Strategy" />
        <Empty label="Strategy is awaiting risk-approved candidates." />
      </div>
    );
  }
  const pair =
    data.tokenInSymbol && data.tokenOutSymbol
      ? `${data.tokenInSymbol} → ${data.tokenOutSymbol}`
      : "—";
  return (
    <div className="rounded-xl border border-violet-200 bg-violet-50/60 p-3 shadow-sm">
      <SectionHeader
        icon="🎯"
        title="Strategy"
        badge={pair}
        tone="bg-violet-100 text-violet-700"
      />
      <div className="grid grid-cols-2 gap-2 text-xs text-slate-700">
        <div className="rounded-md bg-white/80 p-2">
          <span className="block text-[10px] uppercase tracking-wide text-violet-600">
            Size
          </span>
          {formatUsd(data.amountInUsd)}
        </div>
        <div className="rounded-md bg-white/80 p-2">
          <span className="block text-[10px] uppercase tracking-wide text-violet-600">
            Slippage
          </span>
          {data.slippagePct !== undefined ? `${data.slippagePct}%` : "—"}
        </div>
        <div className="rounded-md bg-white/80 p-2">
          <span className="block text-[10px] uppercase tracking-wide text-violet-600">
            Fee tier
          </span>
          {data.feeTier !== undefined ? `${data.feeTier} bps` : "—"}
        </div>
        <div className="rounded-md bg-white/80 p-2">
          <span className="block text-[10px] uppercase tracking-wide text-violet-600">
            Chain
          </span>
          {data.chain ?? "—"}
        </div>
      </div>
      {data.rationale && (
        <p className="mt-2 text-xs text-slate-600">{data.rationale}</p>
      )}
    </div>
  );
};

const CritiqueCard: React.FC<{ data?: CritiqueData }> = ({ data }) => {
  if (!data) {
    return (
      <div className="rounded-xl border border-rose-100 bg-rose-50/40 p-3">
        <SectionHeader icon="⚖️" title="Critic" />
        <Empty label="Critic has not weighed in yet." />
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-rose-200 bg-rose-50/60 p-3 shadow-sm">
      <SectionHeader
        icon="⚖️"
        title="Critic"
        badge={data.approved ? "approved" : "needs revision"}
        tone={
          data.approved
            ? "bg-emerald-100 text-emerald-700"
            : "bg-orange-100 text-orange-700"
        }
      />
      {typeof data.confidence === "number" && (
        <p className="text-xs text-slate-700">
          Confidence:{" "}
          <span className="font-semibold">{Math.round(data.confidence)}%</span>
        </p>
      )}
      {data.notes && (
        <p className="mt-1 text-xs text-slate-600">{data.notes}</p>
      )}
      {data.issues && data.issues.length > 0 && (
        <ul className="mt-2 list-disc space-y-0.5 pl-4 text-xs text-rose-700">
          {data.issues.map((issue, idx) => (
            <li key={`crit-${idx}`}>{issue}</li>
          ))}
        </ul>
      )}
    </div>
  );
};

type WalletBalanceItem = {
  symbol: string;
  address: string;
  decimals: number;
  balance: string;
  rawBalance: string;
};

type WalletPortfolio = {
  address: string;
  balances: WalletBalanceItem[];
  nonZeroBalances: WalletBalanceItem[];
};

const ExecutionCard: React.FC<{
  data?: ExecutionData;
  strategy?: StrategyData;
}> = ({ data, strategy }) => {
  const { open } = useAppKit();
  const { address, isConnected } = useAppKitAccount();
  const { walletProvider } = useAppKitProvider("eip155");
  const [portfolio, setPortfolio] = useState<WalletPortfolio | null>(null);
  const [swapOpen, setSwapOpen] = useState(false);
  const [selectedToken, setSelectedToken] = useState<string>("");
  const [slippagePct, setSlippagePct] = useState<string>(
    String(strategy?.slippagePct ?? 1.5),
  );
  const [amount, setAmount] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [isClient, setIsClient] = useState(false);

  useEffect(() => {
    setIsClient(true);
  }, []);

  useEffect(() => {
    if (!isConnected || !address) {
      setPortfolio(null);
      setSelectedToken("");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/wallet/portfolio?address=${encodeURIComponent(address)}`,
        );
        if (!res.ok) return;
        const payload = (await res.json()) as WalletPortfolio;
        if (cancelled) return;
        setPortfolio(payload);
        const preferredByAddress = strategy?.tokenIn
          ? payload.nonZeroBalances.find(
              (item) =>
                item.address.toLowerCase() === strategy.tokenIn?.toLowerCase(),
            )
          : undefined;
        const preferredBySymbol = strategy?.tokenInSymbol
          ? payload.nonZeroBalances.find(
              (item) =>
                item.symbol.toLowerCase() ===
                strategy.tokenInSymbol?.toLowerCase(),
            )
          : undefined;
        const first =
          preferredByAddress ?? preferredBySymbol ?? payload.nonZeroBalances[0];

        if (first && !selectedToken) {
          setSelectedToken(first.address);
          const strategyUsd = strategy?.amountInUsd;
          const fullBalance = Number(first.balance);
          const fallbackSuggestion = Math.max(fullBalance * 0.2, 0);
          const suggested =
            typeof strategyUsd === "number" && strategyUsd > 0
              ? Math.min(strategyUsd, fullBalance)
              : fallbackSuggestion;
          setAmount(suggested > 0 ? suggested.toFixed(6) : "");
        }
      } catch {
        // Non-fatal in UI
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isConnected,
    address,
    strategy?.tokenIn,
    strategy?.tokenInSymbol,
    strategy?.amountInUsd,
  ]);

  const tokenOptions = portfolio?.nonZeroBalances ?? [];
  const chosen = useMemo(
    () => tokenOptions.find((t) => t.address === selectedToken),
    [tokenOptions, selectedToken],
  );
  const tokenOutAddress = strategy?.tokenOut;
  const tokenOutSymbol = strategy?.tokenOutSymbol ?? "target token";

  const slippageValue = Number(slippagePct);
  const slippageInvalid =
    !Number.isFinite(slippageValue) || slippageValue <= 0 || slippageValue > 10;

  const canSwap =
    Boolean(chosen) &&
    Boolean(tokenOutAddress) &&
    selectedToken !== tokenOutAddress &&
    Boolean(amount) &&
    Number(amount) > 0 &&
    !slippageInvalid &&
    !submitting;

  async function onSwapNow() {
    if (!chosen || !tokenOutAddress || !address || !walletProvider) return;
    try {
      setSubmitting(true);
      setError(null);
      setTxHash(null);

      if (chosen.address === tokenOutAddress) {
        throw new Error("From and To assets must be different");
      }
      if (slippageInvalid) {
        throw new Error("Slippage must be between 0.01% and 10%");
      }

      const amountInWei = ethers.parseUnits(amount, chosen.decimals).toString();
      const prepareRes = await fetch("/api/swap/prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          walletAddress: address,
          tokenIn: chosen.address,
          tokenOut: tokenOutAddress,
          amountInWei,
          slippagePct: slippageValue,
        }),
      });
      const payload = (await prepareRes.json()) as {
        approvalTx?: { to: string; data: string; value?: string } | null;
        swapTx?: { to: string; data: string; value?: string };
        error?: string;
      };
      if (!prepareRes.ok || !payload.swapTx) {
        throw new Error(payload.error ?? "Swap preparation failed");
      }

      const provider = new BrowserProvider(walletProvider as any);
      const signer = await provider.getSigner();

      if (payload.approvalTx) {
        const approvalTx = await signer.sendTransaction({
          to: payload.approvalTx.to,
          data: payload.approvalTx.data,
          value: payload.approvalTx.value
            ? BigInt(payload.approvalTx.value)
            : BigInt(0),
        });
        await approvalTx.wait();
      }

      const swapTx = await signer.sendTransaction({
        to: payload.swapTx.to,
        data: payload.swapTx.data,
        value: payload.swapTx.value ? BigInt(payload.swapTx.value) : BigInt(0),
      });
      await swapTx.wait();
      setTxHash(swapTx.hash);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Swap failed");
    } finally {
      setSubmitting(false);
    }
  }

  if (!data) {
    return (
      <div className="rounded-xl border border-green-100 bg-green-50/40 p-3">
        <SectionHeader icon="⚡" title="Executor" />
        <Empty label="Executor stands by until you approve the trade." />
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-green-200 bg-green-50/60 p-3 shadow-sm">
      <SectionHeader
        icon="⚡"
        title="Executor"
        badge={
          data?.success
            ? data?.dryRun
              ? "dry-run ✓"
              : "executed ✓"
            : "not executed"
        }
        tone={
          data?.success
            ? "bg-emerald-100 text-emerald-700"
            : "bg-orange-100 text-orange-700"
        }
      />
      {data?.pair && (
        <p className="text-xs text-slate-700">
          Pair: <span className="font-semibold">{data?.pair}</span>
        </p>
      )}
      {data?.txHash && (
        <a
          href={`https://etherscan.io/tx/${data.txHash}`}
          target="_blank"
          rel="noreferrer"
          className="mt-1 block break-all rounded-md bg-white/80 p-2 font-mono text-[11px] text-slate-700 underline underline-offset-2 hover:text-slate-900"
          title="Open transaction on Etherscan"
        >
          {data.txHash}
        </a>
      )}
      {data?.rationale && (
        <p className="mt-1 text-xs text-slate-600">{data?.rationale}</p>
      )}
      {!data?.success && tokenOutAddress && (
        <button
          type="button"
          onClick={() => {
            if (!isConnected) {
              open();
              return;
            }
            setSwapOpen(true);
          }}
          className="mt-2 w-full rounded-md bg-emerald-600 px-2 py-1.5 text-[11px] font-semibold text-white hover:bg-emerald-700"
        >
          {isConnected ? "Open Swap" : "Connect Wallet to Swap"}
        </button>
      )}
      {swapOpen &&
        isClient &&
        createPortal(
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="w-full max-w-4xl rounded-2xl border border-emerald-200 bg-white p-5 shadow-2xl">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-base font-semibold text-slate-900">
                  Swap on Uniswap
                </p>
                <button
                  type="button"
                  className="text-xs text-slate-500 hover:text-slate-700"
                  onClick={() => {
                    setSwapOpen(false);
                  }}
                >
                  Close
                </button>
              </div>
              <p className="mb-4 rounded-lg border border-emerald-100 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
                Connected to the <span className="font-semibold">Executor</span>{" "}
                stage. Strategy data is prefilled so you can execute quickly.
              </p>

              <div className="grid gap-5 md:grid-cols-[1.2fr_1fr]">
                <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
                  <p className="mb-3 text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                    Swap Input
                  </p>
                  <p className="mb-3 text-xs text-slate-600">
                    Ethereum mainnet only. To asset comes from pipeline
                    strategy.
                  </p>
                  <p className="mb-3 rounded-md border border-slate-200 bg-white/80 px-2 py-1 text-[11px] text-slate-700">
                    Chain:{" "}
                    <span className="font-semibold">Ethereum (chainId 1)</span>
                  </p>

                  <label className="mb-1 block text-[11px] font-semibold text-slate-600">
                    From asset
                  </label>
                  <select
                    value={selectedToken}
                    onChange={(e) => setSelectedToken(e.target.value)}
                    className="mb-3 w-full rounded-md border border-slate-300 px-2 py-2 text-xs"
                  >
                    {tokenOptions.length === 0 ? (
                      <option value="">No non-zero assets found</option>
                    ) : (
                      tokenOptions.map((t) => (
                        <option key={t.address} value={t.address}>
                          {t.symbol} ({Number(t.balance).toFixed(6)})
                        </option>
                      ))
                    )}
                  </select>

                  <p className="mb-3 rounded-md border border-slate-200 bg-white/80 px-2 py-1 text-[11px] text-slate-700">
                    To asset:{" "}
                    <span className="font-semibold">{tokenOutSymbol}</span>
                  </p>

                  <label className="mb-1 block text-[11px] font-semibold text-slate-600">
                    Amount
                  </label>
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    className="mb-3 w-full rounded-md border border-slate-300 px-2 py-2 text-xs"
                    placeholder="0.0"
                  />
                  <label className="mb-1 block text-[11px] font-semibold text-slate-600">
                    Slippage (%)
                  </label>
                  <input
                    type="number"
                    min="0.01"
                    max="10"
                    step="0.01"
                    value={slippagePct}
                    onChange={(e) => setSlippagePct(e.target.value)}
                    className="mb-3 w-full rounded-md border border-slate-300 px-2 py-2 text-xs"
                    placeholder="1.50"
                  />
                  {slippageInvalid && (
                    <p className="mb-2 text-[11px] text-amber-700">
                      Slippage must be between 0.01% and 10%.
                    </p>
                  )}

                  {error && (
                    <p className="mb-2 rounded-md border border-rose-300 bg-rose-50 px-2 py-1 text-[11px] text-rose-700">
                      {error}
                    </p>
                  )}
                  {txHash && (
                    <a
                      href={`https://etherscan.io/tx/${txHash}`}
                      target="_blank"
                      rel="noreferrer"
                      className="mb-2 block break-all rounded-md border border-emerald-300 bg-emerald-50 px-2 py-1 font-mono text-[11px] text-emerald-700 underline underline-offset-2 hover:text-emerald-900"
                      title="Open transaction on Etherscan"
                    >
                      {txHash}
                    </a>
                  )}
                  <button
                    type="button"
                    disabled={!canSwap}
                    onClick={onSwapNow}
                    className={`w-full rounded-md px-2 py-2 text-xs font-semibold text-white ${
                      canSwap
                        ? "bg-emerald-600 hover:bg-emerald-700"
                        : "cursor-not-allowed bg-slate-300"
                    }`}
                  >
                    {submitting
                      ? "Waiting for wallet signature..."
                      : "Sign & Swap"}
                  </button>
                </div>

                <div className="rounded-xl border border-cyan-200 bg-cyan-50/60 p-4">
                  <p className="mb-3 text-xs font-semibold uppercase tracking-[0.14em] text-cyan-700">
                    Executor Strategy Context
                  </p>
                  <div className="space-y-2 text-xs text-slate-700">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-slate-500">Pair</span>
                      <span className="font-semibold">
                        {chosen?.symbol && tokenOutSymbol
                          ? `${chosen.symbol} → ${tokenOutSymbol}`
                          : strategy?.tokenInSymbol && strategy?.tokenOutSymbol
                            ? `${strategy.tokenInSymbol} → ${strategy.tokenOutSymbol}`
                            : (data?.pair ?? "—")}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-slate-500">Target chain</span>
                      <span className="font-semibold">Ethereum Mainnet</span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-slate-500">Suggested size</span>
                      <span className="font-semibold">
                        {formatUsd(strategy?.amountInUsd)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-slate-500">Slippage</span>
                      <span className="font-semibold">
                        {slippageInvalid ? "—" : `${slippageValue}%`}
                      </span>
                    </div>
                  </div>
                  {strategy?.rationale && (
                    <p className="mt-3 rounded-md bg-white/70 p-2 text-[11px] text-slate-600">
                      {strategy.rationale}
                    </p>
                  )}
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
};

// ── 0G Storage audit trail (rootHash → key) ─────────────────────────────────

const formatHashShort = (hash: string): string => {
  if (hash.length <= 18) return hash;
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`;
};

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
};

const formatTime = (ts: number): string =>
  new Date(ts).toLocaleTimeString(undefined, {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

const StorageAuditCard: React.FC<{ writes?: AgentStorageWrite[] }> = ({
  writes,
}) => {
  const entries = writes ?? [];
  if (entries.length === 0) {
    return (
      <div className="rounded-xl border border-cyan-100 bg-cyan-50/40 p-3">
        <SectionHeader icon="🗄️" title="0G Storage Audit" />
        <Empty label="No agent writes yet — storage hashes will appear here as agents save." />
      </div>
    );
  }

  // Show newest first; keep last 12 entries to avoid runaway lists.
  const sorted = [...entries].sort((a, b) => b.ts - a.ts).slice(0, 12);
  const totalBytes = entries.reduce((sum, e) => sum + (e.sizeBytes ?? 0), 0);

  return (
    <div className="rounded-xl border border-cyan-200 bg-cyan-50/60 p-3 shadow-sm">
      <SectionHeader
        icon="🗄️"
        title="0G Storage Audit"
        badge={`${entries.length} write${entries.length === 1 ? "" : "s"} • ${formatBytes(totalBytes)}`}
        tone="bg-cyan-100 text-cyan-700"
      />
      <ul className="space-y-1.5">
        {sorted.map((entry, idx) => {
          const isLocal = entry.hash.startsWith("local:");
          return (
            <li
              key={`${entry.key}-${entry.hash}-${idx}`}
              className="rounded-md bg-white/80 px-2 py-1.5 text-[11px]"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-slate-800 truncate">
                  {entry.key}
                </span>
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                    isLocal
                      ? "bg-amber-100 text-amber-700"
                      : "bg-emerald-100 text-emerald-700"
                  }`}
                  title={
                    isLocal
                      ? "Stored locally (0G upload failed)"
                      : "Persisted on 0G Storage"
                  }
                >
                  {isLocal ? "local" : "0G ✓"}
                </span>
              </div>
              <div className="mt-1 flex items-center justify-between gap-2 font-mono text-[10px] text-slate-600">
                <span className="truncate">{formatHashShort(entry.hash)}</span>
                <span className="shrink-0 tabular-nums text-slate-500">
                  {formatBytes(entry.sizeBytes ?? 0)} · {formatTime(entry.ts)}
                </span>
              </div>
              <p className="mt-0.5 text-[10px] uppercase tracking-wide text-slate-400">
                by {entry.role}
              </p>
            </li>
          );
        })}
      </ul>
      {entries.length > sorted.length && (
        <p className="mt-2 text-[10px] text-slate-500">
          Showing latest {sorted.length} of {entries.length} writes.
        </p>
      )}
    </div>
  );
};
