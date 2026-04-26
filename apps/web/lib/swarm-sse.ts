export type SwarmEventType =
  | "cycle_start"
  | "agent_start"
  | "agent_done"
  | "delta"
  | "cycle_done"
  | "cycle_error";

export type SwarmEvent = {
  type: SwarmEventType;
  cycleId: string;
  agentId: string;
  content?: string;
  data?: unknown;
  ts: number;
};

type StreamOptions = {
  path: string;
  body?: Record<string, unknown>;
  signal?: AbortSignal;
  onEvent: (event: SwarmEvent) => void;
};

function parseChunkEvents(chunk: string): string[] {
  return chunk
    .split("\n\n")
    .map((block) =>
      block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.replace(/^data:\s?/, ""))
        .join("\n"),
    )
    .filter(Boolean);
}

export async function streamSwarmEvents({
  path,
  body,
  signal,
  onEvent,
}: StreamOptions): Promise<void> {
  const baseUrl =
    process.env.NEXT_PUBLIC_ORCHESTRATOR_URL ?? "http://localhost:4000";
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
    signal,
  });

  if (!res.ok) {
    throw new Error(`SSE request failed (${res.status}): ${await res.text()}`);
  }

  if (!res.body) {
    throw new Error("SSE response body is empty.");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() ?? "";

    for (const block of blocks) {
      for (const payload of parseChunkEvents(block + "\n\n")) {
        if (payload === "[DONE]") return;
        const parsed = JSON.parse(payload) as SwarmEvent;
        onEvent(parsed);
      }
    }
  }
}
