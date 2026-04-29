"use client";

import { useEffect, useMemo, useState } from "react";

type SessionSummary = {
  sessionId: string;
  userId: string;
  createdAt: number;
  lastActivityAt: number;
  cycleCount: number;
  latestCycleId: string | null;
};

type CycleSummary = {
  sessionId: string;
  userId: string;
  cycleId: string;
  startedAt: number;
  completedAt: number | null;
  status: "completed" | "failed";
};

type SwarmHistoryPanelProps = {
  walletAddress?: string;
};

function formatTs(ts?: number | null): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString();
}

export function SwarmHistoryPanel({ walletAddress }: SwarmHistoryPanelProps) {
  const baseUrl =
    process.env.NEXT_PUBLIC_ORCHESTRATOR_URL ?? "http://localhost:4000";
  const ownerKey = useMemo(
    () =>
      walletAddress && walletAddress.trim().length > 0
        ? walletAddress.toLowerCase()
        : "anonymous",
    [walletAddress],
  );
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    null,
  );
  const [cycles, setCycles] = useState<CycleSummary[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [loadingCycles, setLoadingCycles] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setLoadingSessions(true);
      setError(null);
      try {
        const ownerKeys = Array.from(
          new Set(
            ownerKey === "anonymous" ? ["anonymous"] : [ownerKey, "anonymous"],
          ),
        );
        const responses = await Promise.all(
          ownerKeys.map(async (key) => {
            const res = await fetch(
              `${baseUrl}/history/sessions?walletAddress=${encodeURIComponent(key)}&limit=20`,
            );
            const payload = (await res.json()) as {
              data?: SessionSummary[];
              error?: string;
            };
            if (!res.ok) {
              throw new Error(
                payload.error ?? `Failed to load sessions (${res.status})`,
              );
            }
            return payload.data ?? [];
          }),
        );
        if (cancelled) return;
        const rows = Array.from(
          new Map(
            responses
              .flat()
              .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
              .map((row) => [row.sessionId, row]),
          ).values(),
        );
        setSessions(rows);
        setSelectedSessionId((current) =>
          current && rows.some((s) => s.sessionId === current)
            ? current
            : (rows[0]?.sessionId ?? null),
        );
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
      } finally {
        if (!cancelled) setLoadingSessions(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [baseUrl, ownerKey]);

  useEffect(() => {
    if (!selectedSessionId) {
      setCycles([]);
      return;
    }
    let cancelled = false;
    const run = async () => {
      setLoadingCycles(true);
      setError(null);
      try {
        const res = await fetch(
          `${baseUrl}/history/sessions/${encodeURIComponent(selectedSessionId)}/cycles?limit=30`,
        );
        const payload = (await res.json()) as {
          data?: CycleSummary[];
          error?: string;
        };
        if (!res.ok) {
          throw new Error(
            payload.error ?? `Failed to load cycles (${res.status})`,
          );
        }
        if (!cancelled) setCycles(payload.data ?? []);
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
      } finally {
        if (!cancelled) setLoadingCycles(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [baseUrl, selectedSessionId]);

  return (
    <div className="h-full min-h-0 rounded-xl border border-[#d9dbe5] bg-white/70 p-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-800">History</h3>
        <span className="text-[11px] text-slate-500">{ownerKey}</span>
      </div>
      {error ? (
        <p className="mb-2 rounded-md border border-rose-200 bg-rose-50 px-2 py-1 text-xs text-rose-700">
          {error}
        </p>
      ) : null}
      <div className="grid h-[calc(100%-2rem)] min-h-0 grid-cols-2 gap-3">
        <div className="min-h-0 overflow-auto rounded-lg border border-slate-200 bg-white/70 p-2">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Sessions
          </p>
          {loadingSessions ? (
            <p className="text-xs text-slate-500">Loading sessions...</p>
          ) : sessions.length === 0 ? (
            <p className="text-xs text-slate-500">No persisted sessions yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {sessions.map((session) => (
                <li key={session.sessionId}>
                  <button
                    type="button"
                    onClick={() => setSelectedSessionId(session.sessionId)}
                    className={`w-full rounded-md border px-2 py-1.5 text-left text-xs ${
                      selectedSessionId === session.sessionId
                        ? "border-cyan-300 bg-cyan-50"
                        : "border-slate-200 bg-white"
                    }`}
                  >
                    <p className="font-semibold text-slate-800">
                      {session.sessionId.slice(0, 8)}...
                      {session.sessionId.slice(-4)}
                    </p>
                    <p className="text-[11px] text-slate-500">
                      cycles: {session.cycleCount}
                    </p>
                    <p className="text-[11px] text-slate-500">
                      last: {formatTs(session.lastActivityAt)}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="min-h-0 overflow-auto rounded-lg border border-slate-200 bg-white/70 p-2">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Cycles
          </p>
          {loadingCycles ? (
            <p className="text-xs text-slate-500">Loading cycles...</p>
          ) : cycles.length === 0 ? (
            <p className="text-xs text-slate-500">
              Select a session to view cycles.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {cycles.map((cycle) => (
                <li
                  key={cycle.cycleId}
                  className="rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs"
                >
                  <p className="font-semibold text-slate-800">
                    {cycle.cycleId.slice(0, 8)}...{cycle.cycleId.slice(-4)}
                  </p>
                  <p className="text-[11px] text-slate-500">
                    start: {formatTs(cycle.startedAt)}
                  </p>
                  <p className="text-[11px] text-slate-500">
                    end: {formatTs(cycle.completedAt)}
                  </p>
                  <p
                    className={`mt-1 inline-flex rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
                      cycle.status === "completed"
                        ? "bg-emerald-100 text-emerald-700"
                        : "bg-rose-100 text-rose-700"
                    }`}
                  >
                    {cycle.status}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
