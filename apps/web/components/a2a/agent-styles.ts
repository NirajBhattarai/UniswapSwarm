/**
 * Visual styling for swarm A2A agent badges.
 *
 * Color/icon hint maps to the agent role. Mirrors the helper from
 * CopilotKit/a2a-travel but tuned for the Uniswap Swarm fleet.
 */

import { resolveAgent } from "../../lib/swarm-agents";

export type AgentStyle = {
  bgColor: string;
  textColor: string;
  borderColor: string;
  icon: string;
  framework: string;
};

const STYLES: Record<string, AgentStyle> = {
  researcher: {
    bgColor: "bg-gradient-to-r from-emerald-100 to-green-100",
    textColor: "text-emerald-800",
    borderColor: "border-emerald-400",
    icon: "🔎",
    framework: "Research",
  },
  planner: {
    bgColor: "bg-gradient-to-r from-blue-100 to-sky-100",
    textColor: "text-blue-800",
    borderColor: "border-blue-400",
    icon: "🗺️",
    framework: "Planner",
  },
  risk: {
    bgColor: "bg-gradient-to-r from-orange-100 to-amber-100",
    textColor: "text-orange-800",
    borderColor: "border-orange-400",
    icon: "🛡️",
    framework: "Risk",
  },
  strategy: {
    bgColor: "bg-gradient-to-r from-purple-100 to-violet-100",
    textColor: "text-purple-800",
    borderColor: "border-purple-400",
    icon: "🎯",
    framework: "Strategy",
  },
  critic: {
    bgColor: "bg-gradient-to-r from-pink-100 to-rose-100",
    textColor: "text-rose-800",
    borderColor: "border-rose-400",
    icon: "⚖️",
    framework: "Critic",
  },
  executor: {
    bgColor: "bg-gradient-to-r from-lime-100 to-green-100",
    textColor: "text-green-800",
    borderColor: "border-green-400",
    icon: "⚡",
    framework: "Executor",
  },
};

const FALLBACK: AgentStyle = {
  bgColor: "bg-gray-100",
  textColor: "text-gray-700",
  borderColor: "border-gray-300",
  icon: "🤖",
  framework: "",
};

export function getAgentStyle(agentName?: string): AgentStyle {
  if (!agentName) return FALLBACK;
  const descriptor = resolveAgent(agentName);
  if (descriptor) {
    const style = STYLES[descriptor.id];
    if (style) return style;
  }
  const lower = agentName.toLowerCase();
  for (const [id, style] of Object.entries(STYLES)) {
    if (lower.includes(id)) return style;
  }
  return FALLBACK;
}

export function truncateTask(text: string, maxLength = 80): string {
  if (!text) return "";
  if (text.length <= maxLength) return text;
  return `${text.substring(0, maxLength)}…`;
}

/**
 * The orchestrator LLM is instructed to send short natural-language tasks,
 * but Gemini occasionally regresses and pastes a previous agent's raw JSON
 * envelope as `task`. Detect that case so the UI can render a clean
 * "Forwarded payload" pill instead of dumping braces into the chat.
 *
 * Returns the parsed envelope when the string looks like JSON wrapping
 * `{ agentId, data, ... }` or any plain object/array; otherwise null.
 */
export type ForwardedPayload = {
  agentId?: string;
  preview: string;
  byteLength: number;
  raw: string;
};

export function detectForwardedJson(task: string): ForwardedPayload | null {
  if (!task) return null;
  const trimmed = task.trim();
  // Quick reject: must start with { or [ and end with } or ]
  if (
    !(
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    )
  ) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const obj = parsed as Record<string, unknown>;
  const agentId = typeof obj.agentId === "string" ? obj.agentId : undefined;

  // Build a one-line preview of the meaningful data (strip noisy storage
  // arrays / huge nested fields we already render elsewhere).
  const data =
    obj.data && typeof obj.data === "object"
      ? (obj.data as Record<string, unknown>)
      : obj;
  const previewSource: Record<string, unknown> = { ...data };
  delete previewSource.storage;
  const preview = Object.entries(previewSource)
    .slice(0, 3)
    .map(([k, v]) => `${k}=${summariseValue(v)}`)
    .join(", ");

  return {
    agentId,
    preview: preview || "(empty payload)",
    byteLength: trimmed.length,
    raw: trimmed,
  };
}

function summariseValue(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "string") {
    return v.length > 24 ? `"${v.slice(0, 24)}…"` : `"${v}"`;
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return `[${v.length}]`;
  if (typeof v === "object") {
    const keys = Object.keys(v as Record<string, unknown>);
    return `{${keys.slice(0, 2).join(",")}${keys.length > 2 ? "…" : ""}}`;
  }
  return typeof v;
}
