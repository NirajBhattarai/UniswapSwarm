import type { SwarmEvent } from "./swarm-sse";
import { streamSwarmEvents } from "./swarm-sse";

export type WalletWatchInput = {
  walletAddress: string;
  prompt: string;
};

export type WalletWatchState = {
  status: "idle" | "running" | "done" | "error";
  timeline: SwarmEvent[];
  researchSummary: string | null;
  plannerRationale: string | null;
  plannerPlan: unknown;
  error: string | null;
};

export const initialWalletWatchState: WalletWatchState = {
  status: "idle",
  timeline: [],
  researchSummary: null,
  plannerRationale: null,
  plannerPlan: null,
  error: null,
};

export async function runWalletWatchFlow(
  input: WalletWatchInput,
  signal: AbortSignal,
  onEvent: (event: SwarmEvent) => void,
): Promise<{ researchSummary: string | null; plannerPlan: unknown }> {
  let researchSummary: string | null = null;
  let plannerPlan: unknown = null;

  await streamSwarmEvents({
    path: "/wallet-watch/stream",
    body: input,
    signal,
    onEvent: (event) => {
      onEvent(event);
      if (event.type === "agent_done" && event.agentId === "researcher") {
        const data = (event.data ?? {}) as { marketSummary?: string };
        researchSummary = data.marketSummary ?? null;
      }
      if (event.type === "agent_done" && event.agentId === "planner") {
        plannerPlan = event.data ?? null;
      }
    },
  });

  return { researchSummary, plannerPlan };
}
