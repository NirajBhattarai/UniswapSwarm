"use client";

/**
 * SwarmChat — CopilotKit chat that drives the Uniswap A2A swarm.
 *
 * Mirrors CopilotKit/a2a-travel:
 *   - Renders inline cards for each `send_message_to_a2a_agent` call
 *     (MessageToA2A → MessageFromA2A).
 *   - Registers a HITL `gather_swap_intent` form.
 *   - Registers a HITL `request_trade_approval` form before executor runs.
 *   - Extracts structured data from agent results into the sidebar cards.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { BrowserProvider } from "ethers";
import {
  useCopilotAction,
  useCopilotChatInternal,
  useCopilotReadable,
} from "@copilotkit/react-core";
import {
  useAppKit,
  useAppKitAccount,
  useAppKitProvider,
} from "@reown/appkit/react";
import { CopilotChat } from "@copilotkit/react-ui";
import "@copilotkit/react-ui/styles.css";

import type {
  AgentStorageWrite,
  CritiqueData,
  ExecutionData,
  MessageActionRenderProps,
  PlanData,
  ResearchData,
  RiskData,
  StrategyData,
  SwarmAggregateState,
} from "./types";
import { MessageToA2A } from "./a2a/MessageToA2A";
import { MessageFromA2A } from "./a2a/MessageFromA2A";
import { SwapIntentForm } from "./forms/SwapIntentForm";
import { TradeApprovalCard } from "./hitl/TradeApprovalCard";
import { SwarmAuditProvider } from "./swarm-audit-context";

type SwarmChatProps = {
  state: SwarmAggregateState;
  onState: (next: SwarmAggregateState) => void;
};

type ApprovalState = { approved: boolean; rejected: boolean };
type ApprovalErrorState = Record<string, string | null>;
type ApprovalSubmittingState = Record<string, boolean>;

type TxRequestLike = {
  to: string;
  data: string;
  value?: string;
};

type SwapPrepareResponse = {
  approvalTx: TxRequestLike | null;
  /** Full /quote API response — execute route spreads this into the /swap body */
  quoteResponse: Record<string, unknown>;
};

type SwapExecuteResponse =
  | { swapTx: TxRequestLike; type?: never; orderHash?: never }
  | {
      type: "UNISWAPX";
      orderHash: string | null;
      requestId: string | null;
      swapTx?: never;
    };

type WalletBalanceItem = {
  symbol: string;
  address: string;
  balance: string;
  rawBalance: string;
};

type WalletPortfolio = {
  address: string;
  balances: WalletBalanceItem[];
  nonZeroBalances: WalletBalanceItem[];
};

/** Parse a JSON-encoded string argument; returns null on bad/empty input. */
function parseJsonArg<T>(raw: unknown): T | null {
  if (raw == null) return null;
  if (typeof raw === "object") return raw as T;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    return null;
  }
}

function extractTxErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null) {
    const rec = error as Record<string, unknown>;
    const shortMessage = rec["shortMessage"];
    if (typeof shortMessage === "string" && shortMessage) return shortMessage;
    const message = rec["message"];
    if (typeof message === "string" && message) return message;
  }
  return "Transaction failed";
}

/** Strip the `A2A Agent Response: ` prefix the middleware adds. */
function unwrapA2AResult(value: unknown): unknown {
  if (typeof value === "string") {
    const trimmed = value.startsWith("A2A Agent Response: ")
      ? value.substring("A2A Agent Response: ".length)
      : value;
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  return value;
}

function isResearch(payload: unknown): payload is ResearchData {
  return (
    typeof payload === "object" &&
    payload !== null &&
    Array.isArray((payload as { candidates?: unknown[] }).candidates)
  );
}
function isPlan(payload: unknown): payload is PlanData {
  if (typeof payload !== "object" || payload === null) return false;
  const value = payload as { tasks?: unknown; strategy?: unknown };
  return Array.isArray(value.tasks) || typeof value.strategy === "string";
}
function isRisk(payload: unknown): payload is RiskData {
  return (
    Array.isArray(payload) &&
    payload.every(
      (entry) =>
        typeof entry === "object" && entry !== null && "passed" in entry,
    )
  );
}
function isStrategy(payload: unknown): payload is StrategyData {
  if (typeof payload !== "object" || payload === null) return false;
  const value = payload as {
    tokenInSymbol?: unknown;
    tokenOutSymbol?: unknown;
  };
  return (
    typeof value.tokenInSymbol === "string" ||
    typeof value.tokenOutSymbol === "string"
  );
}
function isCritique(payload: unknown): payload is CritiqueData {
  if (typeof payload !== "object" || payload === null) return false;
  const value = payload as { approved?: unknown; confidence?: unknown };
  return (
    typeof value.approved === "boolean" || typeof value.confidence === "number"
  );
}
function isExecution(payload: unknown): payload is ExecutionData {
  if (typeof payload !== "object" || payload === null) return false;
  const value = payload as {
    success?: unknown;
    dryRun?: unknown;
    txHash?: unknown;
  };
  return (
    typeof value.success === "boolean" ||
    typeof value.dryRun === "boolean" ||
    typeof value.txHash === "string"
  );
}

type AgUiToolCall = {
  id: string;
  type?: string;
  function?: { name?: string; arguments?: string };
};

type AgUiMessage = {
  id?: string;
  role?: string;
  content?: unknown;
  toolCalls?: AgUiToolCall[];
  toolCallId?: string;
};

export const SwarmChat: React.FC<SwarmChatProps> = ({ state, onState }) => {
  // `useCopilotChatInternal` is the public entry point that actually exposes
  // the AG-UI `messages` array. (`useCopilotChat`'s `visibleMessages` is a
  // legacy/GQL field that is `undefined` at runtime in current CopilotKit
  // builds because it has been replaced by AG-UI `messages`.)
  const internal = useCopilotChatInternal();
  const messages = useMemo<AgUiMessage[]>(() => {
    const raw = (internal as { messages?: unknown }).messages;
    return Array.isArray(raw) ? (raw as AgUiMessage[]) : [];
  }, [internal]);

  const [approvalStates, setApprovalStates] = useState<
    Record<string, ApprovalState>
  >({});
  const [approvalErrors, setApprovalErrors] = useState<ApprovalErrorState>({});
  const [approvalSubmitting, setApprovalSubmitting] =
    useState<ApprovalSubmittingState>({});
  const [approvalTxHashes, setApprovalTxHashes] = useState<
    Record<string, string | null>
  >({});
  const [portfolio, setPortfolio] = useState<WalletPortfolio | null>(null);
  const { open } = useAppKit();
  const { address, isConnected } = useAppKitAccount();
  const { walletProvider } = useAppKitProvider("eip155");

  // Inject wallet address as structured readable context so the orchestration
  // agent can reliably extract it regardless of system-message content format.
  useCopilotReadable({
    description: "Connected wallet address from Reown AppKit",
    value:
      isConnected && address
        ? `Connected wallet: ${address}`
        : "No wallet connected",
  });

  useEffect(() => {
    if (!isConnected || !address) {
      setPortfolio(null);
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
        if (!cancelled) setPortfolio(payload);
      } catch {
        // Non-fatal: strategy can still run without wallet balances.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isConnected, address]);

  // Track the latest user prompt as the "intent" for the sidebar header.
  useEffect(() => {
    const latestUser = [...messages].reverse().find((m) => m.role === "user");
    const content =
      typeof latestUser?.content === "string" ? latestUser.content : undefined;
    if (content && content !== state.request) {
      onState({ ...state, request: content });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length]);

  // We watch a JSON signature of `(role, toolCallId, content-length)` for
  // every message rather than just `messages.length`. AG-UI tool messages
  // can mutate IN-PLACE as the result streams in (the slot is added when
  // the tool call starts, then `content` is filled in once the A2A
  // server responds), so a length-only dep silently misses the populated
  // payload. Hashing role+toolCallId+content-length gives us a cheap
  // change signal that fires the moment the result lands.
  const messagesSignature = useMemo(() => {
    return messages
      .map((m) => {
        const len = typeof m.content === "string" ? m.content.length : 0;
        return `${m.role ?? "?"}:${m.toolCallId ?? "-"}:${len}`;
      })
      .join("|");
  }, [messages]);

  // Extract structured data (research / plan / risk / strategy / critique /
  // execution) from every send_message_to_a2a_agent tool result.
  // NOTE: 0G Storage writes are aggregated separately via SwarmAuditProvider
  // + MessageFromA2A so we don't fight stale closures here.
  useEffect(() => {
    if (messages.length === 0) return;

    // Build a map: toolCallId -> tool name (from any assistant toolCalls).
    const toolNameById = new Map<string, string>();
    for (const msg of messages) {
      if (msg.role === "assistant" && Array.isArray(msg.toolCalls)) {
        for (const tc of msg.toolCalls) {
          if (tc?.id && tc.function?.name) {
            toolNameById.set(tc.id, tc.function.name);
          }
        }
      }
    }

    const next: SwarmAggregateState = { ...state };
    let dirty = false;

    for (const msg of messages) {
      if (msg.role !== "tool" || !msg.toolCallId) continue;
      const toolName = toolNameById.get(msg.toolCallId);
      if (toolName !== "send_message_to_a2a_agent") continue;

      const parsed = unwrapA2AResult(msg.content);
      if (!parsed || typeof parsed !== "object") continue;

      const wrapper = parsed as {
        agentId?: string;
        data?: unknown;
      };
      const agentId = wrapper.agentId;
      const inner = wrapper.data ?? parsed;

      if (agentId === "researcher" || isResearch(inner)) {
        if (isResearch(inner)) {
          next.research = inner;
          dirty = true;
        }
      } else if (agentId === "planner" || isPlan(inner)) {
        if (isPlan(inner)) {
          next.plan = inner;
          dirty = true;
        }
      } else if (agentId === "risk" || isRisk(inner)) {
        if (isRisk(inner)) {
          next.risk = inner;
          dirty = true;
        }
      } else if (agentId === "strategy" || isStrategy(inner)) {
        if (isStrategy(inner)) {
          next.strategy = inner;
          dirty = true;
        }
      } else if (agentId === "critic" || isCritique(inner)) {
        if (isCritique(inner)) {
          next.critique = inner;
          dirty = true;
        }
      } else if (agentId === "executor" || isExecution(inner)) {
        if (isExecution(inner)) {
          next.execution = inner;
          dirty = true;
        }
      }
    }

    if (next.strategy && !next.execution && isConnected) {
      next.execution = {
        success: false,
        dryRun: false,
        txHash: null,
        pair:
          next.strategy.tokenInSymbol && next.strategy.tokenOutSymbol
            ? `${next.strategy.tokenInSymbol} → ${next.strategy.tokenOutSymbol}`
            : undefined,
        rationale:
          "Swap is ready for wallet signature in the approval card (user-signed flow).",
      };
      dirty = true;
    }

    if (dirty) onState(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messagesSignature, isConnected]);

  const walletContextSnippet = useMemo(() => {
    if (!isConnected || !address) {
      return "Wallet status: not connected.";
    }
    const nonZero = portfolio?.nonZeroBalances ?? [];
    const holdings =
      nonZero.length > 0
        ? nonZero
            .slice(0, 8)
            .map((b) => `${Number(b.balance).toFixed(6)} ${b.symbol}`)
            .join(", ")
        : "no tracked token balances found";
    return `Connected wallet: ${address}. Holdings snapshot: ${holdings}. Prefer strategy tokenIn from held assets with non-zero balance.`;
  }, [isConnected, address, portfolio]);

  // Append fresh 0G Storage writes pushed up by MessageFromA2A. The audit
  // context handles dedupe internally, so we just concat here.
  const handleStorageWrites = useCallback(
    (fresh: AgentStorageWrite[]) => {
      onState({
        ...state,
        storage: [...(state.storage ?? []), ...fresh],
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.storage, onState],
  );

  // ── A2A communication visualisers ────────────────────────────────────────
  useCopilotAction({
    name: "send_message_to_a2a_agent",
    description: "Sends a message to an A2A agent",
    available: "frontend",
    parameters: [
      {
        name: "agentName",
        type: "string",
        description: "The name of the A2A agent to send the message to",
      },
      {
        name: "task",
        type: "string",
        description: "The message to send to the A2A agent",
      },
    ],
    render: (props: MessageActionRenderProps) => (
      <>
        <MessageToA2A {...props} />
        <MessageFromA2A {...props} />
      </>
    ),
  });

  // ── HITL: gather swap intent ─────────────────────────────────────────────
  // Only fires when the user has given NO actionable request (bare greeting
  // like "hi"). Any "find / scout / show me / swap X for Y" message must
  // skip this and go straight to the Researcher Agent — the orchestrator
  // instructions enforce that, and this description reinforces it so the
  // LLM doesn't call the tool defensively.
  useCopilotAction({
    name: "gather_swap_intent",
    description:
      "RARELY USED. Call this ONLY if the user's message is a bare greeting with no actionable request (e.g. 'hi', 'hello', 'what can you do?'). Do NOT call this for messages like 'find safe trades', 'scout opportunities', 'swap X for Y', or anything else with a verb — those must go straight to the Researcher Agent.",
    parameters: [
      {
        name: "goal",
        type: "string",
        description: "Natural language description of the swap goal",
        required: false,
      },
      {
        name: "tokenIn",
        type: "string",
        description: "Token symbol to sell",
        required: false,
      },
      {
        name: "tokenOut",
        type: "string",
        description: "Token symbol to buy",
        required: false,
      },
      {
        name: "amountUsd",
        type: "number",
        description: "Approximate USD size of the trade",
        required: false,
      },
      {
        name: "riskLevel",
        type: "string",
        description: "Conservative, Balanced, or Aggressive",
        required: false,
      },
    ],
    renderAndWaitForResponse: ({ args, respond }) => (
      <SwapIntentForm args={args} respond={respond} />
    ),
  });

  // ── HITL: request trade approval ─────────────────────────────────────────
  // NOTE: We use `type: "string"` (JSON-encoded payload) instead of
  // `type: "object"` because Gemini's function-calling validator rejects
  // top-level object-typed parameters that don't declare nested
  // `properties`. CopilotKit serialises object-typed parameters without
  // sub-attributes as `{ type: "object" }` (no nested properties), which
  // produces a `GenerateContentRequest.tools[*].function_declarations[*].parameters.required[*]: property is not defined`
  // error from Gemini. JSON-encoded strings are LLM-friendly and we
  // already parse the agent envelopes on the frontend.
  useCopilotAction(
    {
      name: "request_trade_approval",
      description:
        "Pause the swarm and ask the user to approve or reject the proposed swap. Pass `strategy` and `critique` as JSON strings of the latest Strategy Agent / Critic Agent results.",
      parameters: [
        {
          name: "strategy",
          type: "string",
          description:
            "JSON string of the proposed TradeStrategy from the Strategy Agent (tokenInSymbol, tokenOutSymbol, amountInUsd, slippagePct, feeTier, chain, rationale, …).",
        },
        {
          name: "critique",
          type: "string",
          description:
            "JSON string of the Critic Agent verdict (approved, confidence, issues, notes). Optional.",
          required: false,
        },
      ],
      renderAndWaitForResponse: ({ args, respond }) => {
        const strategy = parseJsonArg<StrategyData>(args?.strategy);
        const critique = parseJsonArg<CritiqueData>(args?.critique);

        const key = strategy
          ? `${strategy.tokenInSymbol ?? "?"}->${strategy.tokenOutSymbol ?? "?"}-${strategy.amountInUsd ?? "?"}`
          : "pending";
        const current = approvalStates[key] ?? {
          approved: false,
          rejected: false,
        };

        const handleApprove = async () => {
          if (
            !strategy?.tokenIn ||
            !strategy?.tokenOut ||
            !strategy?.amountInWei
          ) {
            setApprovalErrors((prev) => ({
              ...prev,
              [key]:
                "Strategy payload is incomplete (tokenIn/tokenOut/amountInWei missing).",
            }));
            respond?.({
              approved: false,
              message:
                "Approval failed: strategy payload missing on-chain swap fields.",
            });
            return;
          }
          if (!isConnected || !address || !walletProvider) {
            setApprovalErrors((prev) => ({
              ...prev,
              [key]: "Connect your wallet first to sign this swap.",
            }));
            open();
            return;
          }

          setApprovalSubmitting((prev) => ({ ...prev, [key]: true }));
          setApprovalErrors((prev) => ({ ...prev, [key]: null }));
          try {
            // ── Step 1: prepare (check_approval + quote) ────────────────────
            const prepareRes = await fetch("/api/swap/prepare", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                strategy,
                walletAddress: address,
              }),
            });
            const preparePayload = (await prepareRes.json()) as
              | SwapPrepareResponse
              | { error?: string };

            if (!prepareRes.ok || !("quoteResponse" in preparePayload)) {
              throw new Error(
                (preparePayload as { error?: string }).error ??
                  `Swap preparation failed (${prepareRes.status})`,
              );
            }

            const ethersProvider = new BrowserProvider(walletProvider as any);
            const signer = await ethersProvider.getSigner();
            const network = await ethersProvider.getNetwork();
            if (network.chainId !== BigInt(1)) {
              throw new Error(
                "Wrong network: switch wallet to Ethereum Mainnet before approving this swap.",
              );
            }

            // ── Step 2: ERC20 → Permit2 approval (if needed) ───────────────
            if (preparePayload.approvalTx) {
              const approvalTx = await signer.sendTransaction({
                to: preparePayload.approvalTx.to,
                data: preparePayload.approvalTx.data,
                value: preparePayload.approvalTx.value
                  ? BigInt(preparePayload.approvalTx.value)
                  : BigInt(0),
              });
              await approvalTx.wait();
            }

            // ── Step 3: sign Permit2 EIP-712 data (off-chain, no tx) ────────
            // permitData lives inside quoteResponse. For CLASSIC routes the
            // Universal Router needs the signature + permitData in the /swap
            // body. For UniswapX (DUTCH_V2/V3/PRIORITY) only the signature is
            // needed — execute route handles routing-aware body construction.
            let permitSignature: string | null = null;
            const permitData = preparePayload.quoteResponse["permitData"];
            if (permitData && typeof permitData === "object") {
              const pd = permitData as {
                domain: Parameters<typeof signer.signTypedData>[0];
                types: Parameters<typeof signer.signTypedData>[1];
                values: Parameters<typeof signer.signTypedData>[2];
              };
              permitSignature = await signer.signTypedData(
                pd.domain,
                pd.types,
                pd.values,
              );
            }

            // ── Step 4: get swap calldata from Trading API ──────────────────
            const executeRes = await fetch("/api/swap/execute", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                quoteResponse: preparePayload.quoteResponse,
                signature: permitSignature,
              }),
            });
            const executePayload = (await executeRes.json()) as
              | SwapExecuteResponse
              | { error?: string };

            if (!executeRes.ok) {
              throw new Error(
                (executePayload as { error?: string }).error ??
                  `Swap execute failed (${executeRes.status})`,
              );
            }

            // ── Step 5a: UniswapX — order submitted by API, no user tx ──────
            // For Dutch orders the Trading API submits the signed order to
            // UniswapX fillers. No transaction is broadcast by the user.
            if (
              "type" in executePayload &&
              executePayload.type === "UNISWAPX"
            ) {
              const orderHash = executePayload.orderHash ?? "(pending)";
              setApprovalTxHashes((prev) => ({ ...prev, [key]: orderHash }));
              setApprovalStates((prev) => ({
                ...prev,
                [key]: { approved: true, rejected: false },
              }));
              onState({
                ...state,
                execution: {
                  success: true,
                  dryRun: false,
                  txHash: orderHash,
                  pair:
                    strategy.tokenInSymbol && strategy.tokenOutSymbol
                      ? `${strategy.tokenInSymbol} → ${strategy.tokenOutSymbol}`
                      : undefined,
                  rationale:
                    "UniswapX order signed and submitted to fillers — no gas paid by user.",
                },
              });
              respond?.({
                approved: true,
                executedByUserWallet: true,
                txHash: orderHash,
                message:
                  "UniswapX order submitted. Fillers will execute on-chain. Do not call Executor Agent again.",
              });
              return;
            }

            // ── Step 5b: Classic — broadcast the swap tx ────────────────────
            if (!("swapTx" in executePayload) || !executePayload.swapTx) {
              throw new Error(
                (executePayload as { error?: string }).error ??
                  "Swap execute failed: no transaction returned",
              );
            }

            const swapRequest = {
              to: executePayload.swapTx.to,
              data: executePayload.swapTx.data,
              value: executePayload.swapTx.value
                ? BigInt(executePayload.swapTx.value)
                : BigInt(0),
            };

            try {
              const estimatedGas = await signer.estimateGas(swapRequest);
              // Keep a small safety margin to avoid borderline underestimation.
              (swapRequest as { gasLimit?: bigint }).gasLimit =
                (estimatedGas * BigInt(120)) / BigInt(100);
            } catch (estimateError) {
              throw new Error(
                `Swap preflight failed: ${extractTxErrorMessage(estimateError)}`,
              );
            }

            const swapTx = await signer.sendTransaction(swapRequest);
            // Show hash immediately — before waiting for confirmation
            setApprovalTxHashes((prev) => ({ ...prev, [key]: swapTx.hash }));
            await swapTx.wait();

            setApprovalStates((prev) => ({
              ...prev,
              [key]: { approved: true, rejected: false },
            }));
            onState({
              ...state,
              execution: {
                success: true,
                dryRun: false,
                txHash: swapTx.hash,
                pair:
                  strategy.tokenInSymbol && strategy.tokenOutSymbol
                    ? `${strategy.tokenInSymbol} → ${strategy.tokenOutSymbol}`
                    : undefined,
                rationale:
                  "Signed and broadcasted from connected Reown wallet.",
              },
            });

            respond?.({
              approved: true,
              executedByUserWallet: true,
              txHash: swapTx.hash,
              message:
                "Swap signed and sent from connected wallet. Do not call Executor Agent again.",
            });
          } catch (error) {
            const message = extractTxErrorMessage(error);
            setApprovalErrors((prev) => ({
              ...prev,
              [key]: message,
            }));
            respond?.({
              approved: false,
              message: `Swap not sent: ${message}`,
            });
          } finally {
            setApprovalSubmitting((prev) => ({ ...prev, [key]: false }));
          }
        };
        const handleReject = () => {
          setApprovalStates((prev) => ({
            ...prev,
            [key]: { approved: false, rejected: true },
          }));
          respond?.({
            approved: false,
            message: "Trade rejected by user. Do not execute.",
          });
        };

        const handleSwap = () => {
          // Open the ExecutionCard swap modal in the sidebar pipeline panel.
          onState({ ...state, openSwap: true });
          // Unblock the orchestrator — user will sign manually via the swap card.
          respond?.({
            approved: true,
            message:
              "User opened the swap card to execute manually. Do not call Executor Agent.",
          });
        };

        return (
          <TradeApprovalCard
            strategy={strategy}
            critique={critique}
            isApproved={current.approved}
            isRejected={current.rejected}
            isSubmitting={approvalSubmitting[key] === true}
            txHash={approvalTxHashes[key] ?? null}
            error={approvalErrors[key] ?? null}
            onApprove={handleApprove}
            onReject={handleReject}
            onSwap={handleSwap}
          />
        );
      },
    },
    [
      approvalStates,
      approvalSubmitting,
      approvalErrors,
      approvalTxHashes,
      isConnected,
      address,
      walletProvider,
      open,
      onState,
      state,
    ],
  );

  return (
    <SwarmAuditProvider
      storage={state.storage}
      onStorageWrites={handleStorageWrites}
    >
      <CopilotChat
        className="h-full"
        labels={{
          title: "Swarm Chat",
          initial:
            '👋 I\'m your Uniswap Swarm orchestrator.\n\nJust tell me what you want — e.g. "find some safe trades" or "scout opportunities for ~$200". I\'ll dispatch the Researcher first, then Planner → Risk → Strategy → Critic, and only ask for your approval once I have a concrete trade to propose.',
        }}
        instructions={`You are the Uniswap Swarm orchestrator. Dispatch only the stages the user actually asked for. For broad discovery requests, run Researcher first and stop unless the user asks for deeper analysis. Run Risk only when the user explicitly asks for risk/audit/safety checks, or asks for a full pipeline/recommendation/execution. Do NOT call gather_swap_intent unless the user's message has no actionable content. ${walletContextSnippet}`}
        suggestions={[
          {
            title: "Find safe trade",
            message:
              "Find the safest USDC->ETH swap I can do for ~$200 on Arbitrum.",
          },
          {
            title: "Run full pipeline",
            message:
              "Run the full swarm pipeline (research → plan → risk → strategy → critic → executor) for a $100 USDC->UNI swap.",
          },
          {
            title: "Risk audit",
            message:
              "Audit the current candidates for honeypot or liquidity risk.",
          },
        ]}
      />
    </SwarmAuditProvider>
  );
};
