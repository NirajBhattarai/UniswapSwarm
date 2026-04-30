/**
 * Local AG-UI Orchestration Agent for Uniswap Swarm.
 *
 * Mirrors the role of the Python ADK orchestrator in CopilotKit/a2a-travel,
 * but runs entirely in-process inside the Next.js route handler so we don't
 * need a separate AG-UI server. It is wrapped by `A2AMiddlewareAgent`, which
 * auto-injects the `send_message_to_a2a_agent` tool. The middleware then
 * proxies any tool calls produced by this agent to the standalone A2A
 * agent servers (`apps/orchestrator/src/a2aAgents.ts`).
 *
 * Built on @ag-ui/client + Vercel AI SDK (Gemini) so we can:
 *   1) accept AG-UI input (system + user + tool messages),
 *   2) stream Gemini text + tool calls,
 *   3) emit AG-UI events the middleware understands.
 */

import { Observable } from "rxjs";
import { randomUUID } from "node:crypto";
import {
  AbstractAgent,
  type AgentConfig,
  EventType,
  type BaseEvent,
  type RunAgentInput,
  type Message,
  type Tool,
} from "@ag-ui/client";
import {
  streamText,
  jsonSchema,
  type CoreMessage,
  type Tool as AiTool,
} from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const A2A_TOOL_NAME = "send_message_to_a2a_agent";

interface SwarmOrchestrationAgentConfig extends AgentConfig {
  apiKey: string;
  model?: string;
  /** Verified wallet address injected server-side from the x-wallet-address request header. */
  walletAddress?: string;
}

/**
 * Configuration helper – picks first available Google/Gemini API key from the
 * conventional env var names so the orchestrator works whichever the user set.
 */
export function resolveGeminiKey(): string | undefined {
  return process.env.GOOGLE_GENERATIVE_AI_API_KEY;
}

export class SwarmOrchestrationAgent extends AbstractAgent {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly walletAddress?: string;

  constructor(config: SwarmOrchestrationAgentConfig) {
    super(config);
    this.apiKey = config.apiKey;
    this.model = config.model ?? "gemini-2.5-flash";
    this.walletAddress = config.walletAddress;
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      const cancel = { aborted: false };

      const start = async () => {
        subscriber.next({
          type: EventType.RUN_STARTED,
          threadId: input.threadId,
          runId: input.runId,
        } as BaseEvent);

        try {
          const google = createGoogleGenerativeAI({ apiKey: this.apiKey });
          const model = google(this.model);

          const aiMessages = aguiMessagesToAiMessages(input.messages);
          // Prefer the wallet injected via request header (set in page.tsx
          // CopilotKit headers → extracted in route.ts). Fall back to message
          // scanning only if the header was not provided.
          const connectedWallet =
            this.walletAddress ||
            extractConnectedWalletFromMessages(aiMessages);
          const aiTools = aguiToolsToAiTools(input.tools);

          const result = streamText({
            model,
            messages: aiMessages,
            tools: aiTools,
            // Gemini tools require this for parallel-disabled flow used by A2A middleware
            toolChoice: "auto",
          });

          let textMessageId: string | null = null;
          let textOpen = false;

          // Track open tool calls so we can correctly emit START / ARGS / END
          const openToolCalls = new Map<
            string,
            { name: string; argsBuffer: string }
          >();

          for await (const part of result.fullStream) {
            if (cancel.aborted) break;

            if (part.type === "text-delta") {
              if (!textMessageId) {
                textMessageId = randomUUID();
                subscriber.next({
                  type: EventType.TEXT_MESSAGE_START,
                  messageId: textMessageId,
                  role: "assistant",
                } as BaseEvent);
                textOpen = true;
              }
              subscriber.next({
                type: EventType.TEXT_MESSAGE_CONTENT,
                messageId: textMessageId,
                delta: part.textDelta,
              } as BaseEvent);
            }

            if (part.type === "tool-call") {
              // Close any open text message before starting a tool call
              if (textOpen && textMessageId) {
                subscriber.next({
                  type: EventType.TEXT_MESSAGE_END,
                  messageId: textMessageId,
                } as BaseEvent);
                textOpen = false;
                textMessageId = null;
              }

              const toolCallId = part.toolCallId;
              const toolName = part.toolName;
              const enrichedArgs = enrichA2AToolArgs(
                toolName,
                part.args ?? {},
                connectedWallet,
              );
              const argsString = JSON.stringify(enrichedArgs);

              subscriber.next({
                type: EventType.TOOL_CALL_START,
                toolCallId,
                toolCallName: toolName,
              } as BaseEvent);
              subscriber.next({
                type: EventType.TOOL_CALL_ARGS,
                toolCallId,
                delta: argsString,
              } as BaseEvent);
              subscriber.next({
                type: EventType.TOOL_CALL_END,
                toolCallId,
              } as BaseEvent);
              openToolCalls.set(toolCallId, {
                name: toolName,
                argsBuffer: argsString,
              });
            }

            // Streaming tool-call deltas (when supported by the model)
            if (part.type === "tool-call-streaming-start") {
              if (textOpen && textMessageId) {
                subscriber.next({
                  type: EventType.TEXT_MESSAGE_END,
                  messageId: textMessageId,
                } as BaseEvent);
                textOpen = false;
                textMessageId = null;
              }
              subscriber.next({
                type: EventType.TOOL_CALL_START,
                toolCallId: part.toolCallId,
                toolCallName: part.toolName,
              } as BaseEvent);
              openToolCalls.set(part.toolCallId, {
                name: part.toolName,
                argsBuffer: "",
              });
            }

            if (part.type === "tool-call-delta") {
              const open = openToolCalls.get(part.toolCallId);
              if (open) {
                open.argsBuffer += part.argsTextDelta ?? "";
              }
              subscriber.next({
                type: EventType.TOOL_CALL_ARGS,
                toolCallId: part.toolCallId,
                delta: part.argsTextDelta ?? "",
              } as BaseEvent);
            }

            if (part.type === "error") {
              const message =
                part.error instanceof Error
                  ? part.error.message
                  : String(part.error);
              subscriber.next({
                type: EventType.RUN_ERROR,
                message,
              } as BaseEvent);
              subscriber.complete();
              return;
            }
          }

          if (textOpen && textMessageId) {
            subscriber.next({
              type: EventType.TEXT_MESSAGE_END,
              messageId: textMessageId,
            } as BaseEvent);
          }

          subscriber.next({
            type: EventType.RUN_FINISHED,
            threadId: input.threadId,
            runId: input.runId,
          } as BaseEvent);
          subscriber.complete();
        } catch (err) {
          subscriber.next({
            type: EventType.RUN_ERROR,
            message: err instanceof Error ? err.message : String(err),
          } as BaseEvent);
          subscriber.complete();
        }
      };

      void start();

      return () => {
        cancel.aborted = true;
      };
    });
  }
}

/**
 * Flatten any CoreMessage content (string or array of content parts) to a
 * single plain-text string so wallet-address regexes can run on it.
 */
function contentToString(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (typeof part === "object" && part !== null) {
          const p = part as Record<string, unknown>;
          if (typeof p.text === "string") return p.text;
          if (typeof p.content === "string") return p.content;
        }
        return "";
      })
      .join(" ")
      .trim();
  }
  return "";
}

function extractConnectedWalletFromMessages(
  messages: CoreMessage[],
): string | undefined {
  for (const message of messages) {
    const text = contentToString(message.content);
    if (!text) continue;
    const labeledMatch =
      text.match(/connected wallet\s*:\s*(0x[a-fA-F0-9]{40})/i) ??
      text.match(/wallet(?:\s+address)?\s*[:=]\s*(0x[a-fA-F0-9]{40})/i) ??
      text.match(/"walletAddress"\s*:\s*"(0x[a-fA-F0-9]{40})"/i);
    const wallet = labeledMatch?.[1]?.toLowerCase();
    if (wallet && wallet !== ZERO_ADDRESS) return wallet;
  }
  return undefined;
}

function enrichA2AToolArgs(
  toolName: string,
  rawArgs: unknown,
  connectedWallet?: string,
): unknown {
  if (toolName !== A2A_TOOL_NAME) return rawArgs;
  if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) {
    return rawArgs;
  }

  const args = rawArgs as Record<string, unknown>;
  const task = typeof args.task === "string" ? args.task : "";
  if (!task) return rawArgs;

  const sanitizedTask = task
    .replace(/\n?Wallet:\s*0x[a-fA-F0-9]{40}\b/gi, "")
    .replace(/\n?wallet(?:\s+address)?\s*[:=]\s*0x[a-fA-F0-9]{40}\b/gi, "")
    .trim();
  if (!connectedWallet) {
    return { ...args, task: sanitizedTask };
  }
  return {
    ...args,
    task: `${sanitizedTask}\nWallet: ${connectedWallet}`,
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

function aguiMessagesToAiMessages(messages: Message[]): CoreMessage[] {
  const out: CoreMessage[] = [];
  for (const m of messages) {
    if (m.role === "system" || m.role === "developer") {
      // Always coerce to string so wallet-address extraction works regardless
      // of whether CopilotKit sends content as a string or an array of parts.
      out.push({ role: "system", content: contentToString(m.content ?? "") });
      continue;
    }
    if (m.role === "user") {
      out.push({ role: "user", content: m.content ?? "" });
      continue;
    }
    if (m.role === "assistant") {
      const toolCalls =
        "toolCalls" in m && Array.isArray(m.toolCalls) ? m.toolCalls : [];
      if (toolCalls.length > 0) {
        out.push({
          role: "assistant",
          content: [
            ...((m.content ?? "").length > 0
              ? [{ type: "text" as const, text: m.content as string }]
              : []),
            ...toolCalls.map((tc) => ({
              type: "tool-call" as const,
              toolCallId: tc.id,
              toolName: tc.function.name,
              args: safeJsonParse(tc.function.arguments) ?? {},
            })),
          ],
        });
      } else {
        out.push({ role: "assistant", content: m.content ?? "" });
      }
      continue;
    }
    if (m.role === "tool") {
      const toolCallId = (m as { toolCallId?: string }).toolCallId ?? m.id;
      out.push({
        role: "tool",
        content: [
          {
            type: "tool-result" as const,
            toolCallId,
            toolName:
              (m as { name?: string }).name ?? "send_message_to_a2a_agent",
            result: m.content ?? "",
          },
        ],
      });
    }
  }
  return out;
}

function aguiToolsToAiTools(tools: Tool[]): Record<string, AiTool> {
  const map: Record<string, AiTool> = {};
  for (const tool of tools) {
    map[tool.name] = {
      description: tool.description,
      parameters: jsonSchema(
        sanitiseGeminiSchema(
          tool.parameters as JsonSchemaLike | undefined,
        ) as Parameters<typeof jsonSchema>[0],
      ),
    } as AiTool;
  }
  return map;
}

// ─────────────────────────────────────────────────────────────────────────────
// JSON-Schema sanitiser for Gemini's function-calling validator.
//
// Gemini rejects tool parameter schemas that:
//   - omit `properties` on `type: "object"` (still allowed if `properties: {}`)
//   - list a name in `required` that isn't present in `properties`
//   - declare unsupported keywords (e.g. `additionalProperties`, `$schema`,
//     `$defs`, `definitions`).
// We recursively normalise any schema we hand to streamText so that any tool
// (frontend HITL action, A2A middleware tool, or future additions) is safe.
// ─────────────────────────────────────────────────────────────────────────────

type JsonSchemaLike = {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchemaLike>;
  required?: string[];
  items?: JsonSchemaLike | JsonSchemaLike[];
  enum?: unknown[];
  anyOf?: JsonSchemaLike[];
  oneOf?: JsonSchemaLike[];
  [key: string]: unknown;
};

function sanitiseGeminiSchema(
  input: JsonSchemaLike | undefined,
): JsonSchemaLike {
  const root = input && typeof input === "object" ? input : {};
  return normaliseSchema(root, /*topLevel*/ true);
}

function normaliseSchema(
  schema: JsonSchemaLike,
  topLevel = false,
): JsonSchemaLike {
  if (!schema || typeof schema !== "object") {
    return { type: "object", properties: {} };
  }

  const out: JsonSchemaLike = { ...schema };
  // Strip Gemini-unfriendly metadata keys.
  delete out.$schema;
  delete out.$defs;
  delete out.definitions;
  delete out.additionalProperties;

  if (Array.isArray(out.type)) {
    const nonNull = out.type.filter((t) => t !== "null");
    out.type = nonNull[0] ?? "string";
  }

  const effectiveType = out.type ?? (topLevel ? "object" : undefined);

  if (effectiveType === "object") {
    const props =
      out.properties && typeof out.properties === "object"
        ? out.properties
        : {};
    const normalisedProps: Record<string, JsonSchemaLike> = {};
    for (const [key, value] of Object.entries(props)) {
      normalisedProps[key] = normaliseSchema(value as JsonSchemaLike, false);
    }
    out.type = "object";
    out.properties = normalisedProps;
    if (Array.isArray(out.required)) {
      const filtered = out.required.filter(
        (name) => typeof name === "string" && name in normalisedProps,
      );
      if (filtered.length > 0) {
        out.required = filtered;
      } else {
        delete out.required;
      }
    }
  } else if (effectiveType === "array") {
    if (Array.isArray(out.items)) {
      out.items = out.items.map((item) =>
        normaliseSchema(item as JsonSchemaLike, false),
      );
    } else if (out.items) {
      out.items = normaliseSchema(out.items as JsonSchemaLike, false);
    } else {
      out.items = { type: "string" };
    }
  }

  if (Array.isArray(out.anyOf)) {
    out.anyOf = out.anyOf.map((s) => normaliseSchema(s, false));
  }
  if (Array.isArray(out.oneOf)) {
    out.oneOf = out.oneOf.map((s) => normaliseSchema(s, false));
  }

  return out;
}

function safeJsonParse(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
