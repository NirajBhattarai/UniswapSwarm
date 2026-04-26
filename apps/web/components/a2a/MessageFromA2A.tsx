"use client";

/**
 * MessageFromA2A — blue "agent → orchestrator" response card rendered after
 * `send_message_to_a2a_agent` returns a result. Shows a compact badge
 * summarising any 0G Storage writes the agent performed (rootHash, key,
 * size).
 */

import React, { useEffect } from "react";
import type { AgentStorageWrite, MessageActionRenderProps } from "../types";
import { getAgentStyle } from "./agent-styles";
import { useSwarmAudit } from "../swarm-audit-context";

const A2A_PREFIX = "A2A Agent Response: ";

const truncateHash = (hash: string): string => {
  if (hash.length <= 14) return hash;
  return `${hash.slice(0, 8)}…${hash.slice(-4)}`;
};

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
};

/**
 * The middleware delivers the tool result as a string prefixed with
 * "A2A Agent Response: " and JSON encoding `{ agentId, data, storage }`.
 * Parse it defensively and pull the storage trail out.
 */
function extractStorageWrites(result: unknown): AgentStorageWrite[] {
  if (!result) return [];
  let payload: unknown = result;
  if (typeof payload === "string") {
    const trimmed = payload.startsWith(A2A_PREFIX)
      ? payload.slice(A2A_PREFIX.length)
      : payload;
    try {
      payload = JSON.parse(trimmed);
    } catch {
      return [];
    }
  }
  if (!payload || typeof payload !== "object") return [];
  const storage = (payload as { storage?: unknown }).storage;
  if (!Array.isArray(storage)) return [];
  return storage.filter(
    (entry): entry is AgentStorageWrite =>
      !!entry &&
      typeof entry === "object" &&
      typeof (entry as AgentStorageWrite).key === "string" &&
      typeof (entry as AgentStorageWrite).hash === "string",
  );
}

export const MessageFromA2A: React.FC<MessageActionRenderProps> = (props) => {
  const { recordStorageWrites } = useSwarmAudit();

  // Push any 0G Storage writes carried in this A2A response up to the
  // sidebar audit card. We do this in an effect (not in render) so the
  // parent state update doesn't fire during a child's render phase.
  // The dedupe Set inside the audit context guarantees we never count
  // the same write twice across re-renders.
  useEffect(() => {
    if (props.status !== "complete") return;
    const writes = extractStorageWrites(props.result);
    if (writes.length > 0) recordStorageWrites(writes);
  }, [props.status, props.result, recordStorageWrites]);

  if (props.status !== "complete") return null;
  const { args, result } = props;
  const agentStyle = getAgentStyle(args.agentName);
  const writes = extractStorageWrites(result);

  return (
    <div className="my-2 swarm-card-in-right">
      <div className="bg-sky-50 border border-sky-200 rounded-xl px-4 py-3 shadow-sm">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2 min-w-[200px] flex-shrink-0">
            <div className="flex flex-col items-center">
              <span
                className={`px-3 py-1 rounded-full text-xs font-semibold border-2 ${agentStyle.bgColor} ${agentStyle.textColor} ${agentStyle.borderColor} flex items-center gap-1`}
              >
                <span>{agentStyle.icon}</span>
                <span>{args.agentName ?? "Agent"}</span>
              </span>
              {agentStyle.framework && (
                <span className="text-[9px] text-slate-500 mt-0.5">
                  {agentStyle.framework}
                </span>
              )}
            </div>

            <span
              aria-hidden
              className="swarm-arrow is-busy-reverse is-reverse"
            />

            <div className="flex flex-col items-center">
              <span className="px-3 py-1 rounded-full text-xs font-semibold bg-slate-800 text-white">
                Orchestrator
              </span>
              <span className="text-[9px] text-slate-500 mt-0.5">Gemini</span>
            </div>
          </div>

          <span className="text-xs text-emerald-700 font-medium inline-flex items-center gap-1">
            <span aria-hidden>✓</span>
            <span>Response received</span>
          </span>
        </div>

        {writes.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-sky-100 pt-2">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-cyan-700">
              🗄️ 0G Storage
            </span>
            {writes.map((entry, idx) => {
              const isLocal = entry.hash.startsWith("local:");
              return (
                <span
                  key={`${entry.key}-${entry.hash}-${idx}`}
                  // Stagger each chip in by ~50ms so they appear to arrive
                  // sequentially after the bubble itself slides in.
                  style={{ animationDelay: `${100 + idx * 60}ms` }}
                  className={`swarm-chip-in inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px] ${
                    isLocal
                      ? "border-amber-300 bg-amber-50 text-amber-800"
                      : "border-cyan-300 bg-white text-cyan-800"
                  }`}
                  title={`${entry.role} wrote ${entry.key} → ${entry.hash} (${formatBytes(
                    entry.sizeBytes ?? 0,
                  )})`}
                >
                  <span className="font-semibold not-italic">{entry.key}</span>
                  <span className="opacity-70">→</span>
                  <span>{truncateHash(entry.hash)}</span>
                  <span className="opacity-60">·</span>
                  <span>{formatBytes(entry.sizeBytes ?? 0)}</span>
                </span>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
