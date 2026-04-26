"use client";

/**
 * MessageToA2A — green "orchestrator → agent" comm card rendered in the chat
 * for every `send_message_to_a2a_agent` call.
 *
 * Renders in three distinct visual states:
 *
 *   • inProgress / executing → the orchestrator's task is in flight to the
 *     agent. We show a flowing-shimmer arrow, a pulsing ring around the
 *     busy agent badge, and a 3-dot "thinking" indicator next to the task.
 *   • complete → request landed. Arrow goes flat, ring stops, the card sits
 *     quietly above the corresponding MessageFromA2A bubble.
 */

import React from "react";
import type { MessageActionRenderProps } from "../types";
import {
  detectForwardedJson,
  getAgentStyle,
  truncateTask,
} from "./agent-styles";

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
};

export const MessageToA2A: React.FC<MessageActionRenderProps> = ({
  status,
  args,
}) => {
  if (
    status !== "executing" &&
    status !== "complete" &&
    status !== "inProgress"
  ) {
    return null;
  }
  const isBusy = status !== "complete";
  const agentStyle = getAgentStyle(args.agentName);
  const rawTask = typeof args.task === "string" ? args.task : "";

  // The orchestrator LLM is instructed to send short directives, but if
  // Gemini regresses and pastes a previous agent's JSON envelope into
  // `task`, render it as a compact "forwarded payload" pill instead of
  // dumping braces inline. The user can hover for the full content.
  const forwarded = detectForwardedJson(rawTask);

  return (
    <div
      className={`swarm-card-in-left bg-emerald-50 border ${
        isBusy ? "border-emerald-300" : "border-emerald-200"
      } rounded-xl px-4 py-3 my-2 shadow-sm transition-colors duration-300`}
    >
      <div className="flex items-start gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-shrink-0">
          <div className="flex flex-col items-center">
            <span className="px-3 py-1 rounded-full text-xs font-semibold bg-slate-800 text-white">
              Orchestrator
            </span>
            <span className="text-[9px] text-slate-500 mt-0.5">Gemini</span>
          </div>

          <span
            aria-hidden
            className={`swarm-arrow ${isBusy ? "is-busy" : "is-done"}`}
          />

          <div className="flex flex-col items-center">
            <span
              className={`px-3 py-1 rounded-full text-xs font-semibold border-2 ${agentStyle.bgColor} ${agentStyle.textColor} ${agentStyle.borderColor} flex items-center gap-1 ${
                isBusy ? "swarm-pulse-ring" : ""
              }`}
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
        </div>

        <span
          className="text-slate-700 text-sm flex-1 min-w-0 break-words flex items-center gap-2"
          title={rawTask}
        >
          {forwarded ? (
            <span
              className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] text-amber-900"
              title={rawTask}
            >
              <span aria-hidden>📎</span>
              <span className="font-semibold">
                Forwarded payload
                {forwarded.agentId ? ` from ${forwarded.agentId}` : ""}
              </span>
              <span className="font-mono opacity-80 truncate max-w-[260px]">
                {forwarded.preview}
              </span>
              <span className="opacity-60">·</span>
              <span className="opacity-70">
                {formatBytes(forwarded.byteLength)}
              </span>
            </span>
          ) : (
            <span className="min-w-0 break-words">{truncateTask(rawTask)}</span>
          )}
          {isBusy && (
            <span className="swarm-dots text-emerald-600" aria-hidden>
              <span />
              <span />
              <span />
            </span>
          )}
        </span>
      </div>
    </div>
  );
};
