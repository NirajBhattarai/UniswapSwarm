/**
 * CopilotKit API Route with A2A Middleware
 *
 * Mirrors CopilotKit/a2a-travel:
 *   Frontend (CopilotKit) → A2A Middleware → Orchestration LLM (Gemini)
 *                                          ↘ A2A Agents (researcher, planner, …)
 *
 * - AG-UI Protocol  : Frontend ↔ orchestration agent (in-process here)
 * - A2A Protocol    : Orchestration ↔ specialized Uniswap Swarm agents
 * - A2A Middleware  : Wraps the orchestration agent and injects the
 *                     `send_message_to_a2a_agent` tool, then routes calls
 *                     to the standalone agent servers in
 *                     apps/orchestrator/src/a2aAgents.ts.
 */

import { NextRequest } from "next/server";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import {
  CopilotRuntime,
  ExperimentalEmptyAdapter,
  copilotRuntimeNextJSAppRouterEndpoint,
} from "@copilotkit/runtime";
import { A2AMiddlewareAgent } from "@ag-ui/a2a-middleware";
import {
  SwarmOrchestrationAgent,
  resolveGeminiKey,
} from "../../../lib/orchestration-agent";
import { SWARM_AGENTS, getSwarmAgentUrls } from "../../../lib/swarm-agents";

// Load env from web/.env.local first then project root .env so devs can keep
// keys either place.
const webEnvLocal = resolve(process.cwd(), ".env.local");
const rootEnv = resolve(process.cwd(), "../../.env");
if (existsSync(webEnvLocal)) loadDotenv({ path: webEnvLocal });
if (existsSync(rootEnv)) loadDotenv({ path: rootEnv });

const ORCHESTRATOR_INSTRUCTIONS = `
You are the Uniswap Swarm orchestrator. You coordinate 6 specialized A2A agents
to research, plan, risk-check, strategize, critique, and execute Uniswap swaps.

🚨 CRITICAL: CALL EACH AGENT ONLY ONCE PER TURN 🚨
Each agent (Researcher, Planner, Risk, Strategy, Critic, Executor) must be
called EXACTLY ONCE in a pipeline run. If you have already received a response
from an agent in this conversation turn, DO NOT call that agent again. All
agent outputs persist in shared 0G memory and can be read by subsequent agents.

AVAILABLE AGENTS (call by exact name with send_message_to_a2a_agent):
  - "Researcher Agent" : ranks candidate Uniswap tokens, fetches CoinGecko + pool data
  - "Planner Agent"    : turns the research report into a structured TradePlan
  - "Risk Agent"       : flags honeypots, ownership, MEV, liquidity issues
  - "Strategy Agent"   : picks the safest highest-scoring candidate, builds swap calldata spec
  - "Critic Agent"     : approves or rejects the plan + strategy with confidence
  - "Executor Agent"   : legacy backend executor (avoid when user wallet signing is available)

DEFAULT WORKFLOW (the user asked for end-to-end trade analysis/execution):
  Run agents ONE AT A TIME in strict sequence. Wait for each result before
  calling the next. DO NOT skip steps. DO NOT call any agent twice.

  1. Researcher Agent — DISCOVER candidate tokens for the user's goal.
     This is the very first thing you do. Pass the user's natural-language
     request verbatim as the \`task\` argument. The Researcher's job is
     literally to find tokens, so do NOT ask the user for tokenIn/tokenOut
     before running it.
     ✓ After Researcher returns, it is DONE. Do NOT call it again.

  2. Planner Agent — build a TradePlan from the research output.
     ✓ After Planner returns, it is DONE. Do NOT call it again.

  3. Risk Agent — score risk for the planner's tasks. Call this ONCE ONLY.
     ✓ After Risk returns, it is DONE. Do NOT call it again under any circumstances.

  4. Strategy Agent — pick the best safe candidate and build the swap spec.
     ✓ After Strategy returns, it is DONE. Do NOT call it again.

  5. Critic Agent — approve or reject the plan + strategy.
     ✓ After Critic returns, it is DONE. Do NOT call it again unless it
       explicitly requests revisions to a specific upstream agent.

  6. **HITL — request_trade_approval** (REQUIRED before execution)
     Pass the strategy JSON (and critique JSON if available). Wait for the
     user to approve or reject. THIS is the place where the user reviews the
     trade — not earlier.

  7. If approved, the frontend handles wallet signing + send from the user's
     connected wallet (Reown). Do NOT call Executor Agent after approval unless
     the user explicitly asks for backend simulation/executor mode.

WHEN TO USE \`gather_swap_intent\` (RARE):
  ONLY call \`gather_swap_intent\` when the user's message is genuinely empty
  of intent — i.e. a bare greeting like "hi", "hello", "what can you do?", or
  a single word with no verb. ANY actionable request must skip the form and
  go straight to step 1 (Researcher Agent). Examples that MUST skip the form
  and start the pipeline immediately:

    - "find some safe trades"
    - "scout opportunities"
    - "show me something to swap"
    - "find safe USDC -> ETH swap for $200"
    - "audit current candidates"
    - "run the full pipeline"
    - "swap 100 USDC for UNI"

  The Researcher is what discovers tokens. Asking the user for tokens before
  the Researcher runs defeats the whole point of the swarm. When in doubt:
  skip the form, dispatch Researcher.

ROUTING MODES (IMPORTANT):
- For broad "find/scout/show opportunities" requests:
  run Researcher first, then decide whether the user asked for only discovery
  or a full trade decision. If it is discovery-only, STOP after Researcher.
- For planning-only requests (mentions "plan", "planning", "trade plan"):
  run Planner and STOP unless user explicitly asks for risk/strategy/execution.
- Call Risk Agent ONLY when:
  1) user explicitly asks for risk/audit/safety checks, OR
  2) user asks for a full pipeline, concrete recommendation, or execution.
  **AND NEVER MORE THAN ONCE PER TURN** — if you already called Risk Agent
  in this conversation turn, skip it entirely even if you think it should run
  again. Risk assessments are cached in shared 0G memory and persist across
  the session.
- Do NOT call downstream agents "just in case". If the user asked for one
  stage, run that stage and stop.

CRITICAL RULES:
- Default behaviour for any non-greeting input: jump straight to Researcher
  Agent when intent is broad/underspecified. Never call \`gather_swap_intent\`
  defensively.
- Always call \`request_trade_approval\` before any execution.
- After \`request_trade_approval\` returns approved=true with a tx hash, treat
  execution as COMPLETE and do NOT call Executor Agent again.
- Call tools strictly one at a time, wait for the result before the next call.
- After execution, summarise the full pipeline for the user (route, slippage,
  approval verdict, dry-run flag, tx hash if any).
- **NEVER CALL THE SAME AGENT TWICE IN ONE CONVERSATION TURN** — each agent
  (Researcher, Planner, Risk, Strategy, Critic, Executor) should be called
  EXACTLY ONCE per pipeline run. If you already called "Risk Agent" in this
  turn, DO NOT call it again. The only exception is if the Critic explicitly
  requests revisions, in which case you may re-run specific agents it names.
- Track which agents you have called: after each \`send_message_to_a2a_agent\`
  completes, mentally note that agent is done for this cycle.

HOW TO WRITE THE \`task\` ARGUMENT (USER-VISIBLE — DO NOT IGNORE):
  The \`task\` string of every \`send_message_to_a2a_agent\` call is rendered
  verbatim in the chat as the orchestrator → agent message. It MUST be a
  short natural-language directive, NEVER raw JSON or a paste of any prior
  agent's output.

  Each agent already reads every prior agent's output directly from shared
  0G-backed memory before it runs. You do NOT need to (and MUST NOT) paste
  upstream JSON, JSON fragments, or copied field values into the next
  agent's task. Doing so floods the chat with unreadable text and wastes
  tokens. Just send the directive — the agent fetches context itself.

  GOOD task strings (use this style, keep under ~200 chars):
    Researcher : "Find safe swap candidates around USDC, ETH, ARB on
                  Arbitrum for a ~$200 trade."
    Planner    : "Build a TradePlan from the latest research candidates."
    Risk       : "Score risk for the candidates from the planner."
    Strategy   : "Pick the safest highest-scoring candidate and build the
                  swap calldata spec."
    Critic     : "Review the strategy + plan and approve/reject with
                  confidence."
    Executor   : "Execute the approved swap."
    \`{"agentId":"planner","data":{...}}\`               (raw JSON)
    \`Here is the planner output: {...}. Assess risk.\`  (embedded JSON)
    \`Use these candidates: USDC (score=85), USDT...\`   (copy-pasted fields)

  When you receive an agent response, ACKNOWLEDGE briefly in your own
  natural-language assistant message, then issue the next \`task\` as a
  fresh directive — never echo or forward the JSON.

NOTE ON WALLET:
  Do NOT manually append any wallet address to the \`task\` string.
  The wallet address is automatically injected by the middleware layer
  using the verified Reown-connected address. Any address you add will
  be stripped and replaced, so including one only risks sending a wrong value.
`;

async function handleCopilotRequest(request: NextRequest) {
  const apiKey = resolveGeminiKey();
  if (!apiKey) {
    return new Response(
      JSON.stringify({
        error:
          "Gemini API key missing. Set GOOGLE_GENERATIVE_AI_API_KEY (preferred) or GOOGLE_API_KEY / GEMINI_API_KEY in apps/web/.env.local or project root .env, then restart dev server.",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  // Extract the verified Reown wallet address forwarded by the frontend as a
  // custom request header. CopilotKit's `headers` prop (set in page.tsx) adds
  // it to every runtime POST. Validate it is a real-looking Ethereum address
  // before trusting it; fall back to undefined so the agent marks it anonymous.
  const rawWallet = request.headers.get("x-wallet-address")?.trim() ?? "";
  const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
  const walletAddress =
    /^0x[a-fA-F0-9]{40}$/.test(rawWallet) &&
    rawWallet.toLowerCase() !== ZERO_ADDRESS
      ? rawWallet.toLowerCase()
      : undefined;

  const orchestrationAgent = new SwarmOrchestrationAgent({
    description:
      "Uniswap Swarm orchestrator: routes user requests across 6 specialized A2A trading agents.",
    apiKey,
    model: process.env.COPILOTKIT_MODEL ?? "gemini-2.5-flash",
    walletAddress,
  });

  const agentUrls = getSwarmAgentUrls();

  // Pre-flight: confirm every A2A agent's card is reachable. The
  // A2AMiddlewareAgent eagerly does Promise.all(getAgentCard()) inside its
  // constructor; if any fails the rejection bubbles up as an opaque
  // "#<Promise> could not be cloned." HTTP 500 from the runtime. We probe
  // both the legacy and current well-known paths so we work with both
  // @a2a-js/sdk@0.2.x and @a2a-js/sdk@0.3.x servers.
  const cardCheck = await checkAgentCards(agentUrls);
  if (!cardCheck.ok) {
    const resolvedBases = Array.from(
      new Set(
        agentUrls.map((url) => {
          try {
            return new URL(url).origin;
          } catch {
            return url;
          }
        }),
      ),
    );
    return new Response(
      JSON.stringify({
        error: "A2A agent servers unreachable",
        message:
          "One or more Uniswap Swarm A2A agent servers are not running or did not expose an agent card. Set ORCHESTRATOR_URL (or NEXT_PUBLIC_ORCHESTRATOR_URL) to your deployed orchestrator base URL and ensure /a2a/agents/* routes are reachable.",
        resolvedAgentBases: resolvedBases,
        details: cardCheck.failures,
      }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    );
  }

  const a2aMiddlewareAgent = new A2AMiddlewareAgent({
    description: `Uniswap Swarm trading assistant with ${SWARM_AGENTS.length} specialized A2A agents (Researcher, Planner, Risk, Strategy, Critic, Executor).`,
    agentUrls,
    orchestrationAgent,
    instructions: ORCHESTRATOR_INSTRUCTIONS,
  });

  // CopilotKit's runtime calls `agent.clone()` before each run. The default
  // `AbstractAgent.clone()` walks every own property and calls
  // `structuredClone` on each — which throws DataCloneError on the
  // middleware's `agentCards` (a Promise) and `agentClients` (A2AClient
  // class instances). Override with a safe shallow clone that copies these
  // unsupported references by-reference. We already construct a fresh
  // A2AMiddlewareAgent per request, so sharing these handles is safe.
  installSafeClone(a2aMiddlewareAgent);
  installSafeClone(orchestrationAgent);

  const runtime = new CopilotRuntime({
    agents: {
      // Must match <CopilotKit agent="swarm_chat"> in the providers / page.
      // The cast accommodates a minor type mismatch between the
      // @copilotkit/runtime version and the @ag-ui/client version pulled in
      // through @ag-ui/a2a-middleware. The runtime contract is satisfied
      // structurally — both expose the AbstractAgent.run shape that the
      // runtime invokes.
      swarm_chat: a2aMiddlewareAgent as unknown as never,
    },
  });

  const { handleRequest } = copilotRuntimeNextJSAppRouterEndpoint({
    runtime,
    serviceAdapter: new ExperimentalEmptyAdapter(),
    endpoint: "/api/copilotkit",
  });

  return handleRequest(request);
}

export const GET = handleCopilotRequest;
export const POST = handleCopilotRequest;

const CARD_PATHS = [".well-known/agent.json", ".well-known/agent-card.json"];

type CardCheck =
  | { ok: true }
  | { ok: false; failures: { url: string; error: string }[] };

/**
 * Replace `agent.clone()` with a structured-clone-safe shallow copy.
 *
 * The default AbstractAgent.clone() iterates every own property of `this`
 * and calls `structuredClone(value)`. That fails for:
 *   - Promise instances (e.g. A2AMiddlewareAgent#agentCards)
 *   - Class instances with non-cloneable internals (e.g. A2AClient)
 *   - Functions defined on the instance
 *
 * Copying class instances and Promises by reference is fine because we
 * recreate the agent on every request, so there is no cross-request state
 * bleed. Plain data fields (messages, state, threadId, …) are still
 * structured-cloned so the runtime gets a fresh per-run snapshot.
 */
function installSafeClone(agent: unknown): void {
  type CloneTarget = {
    clone: () => unknown;
  };
  const target = agent as Record<string, unknown> & CloneTarget;
  target.clone = function safeClone() {
    const proto = Object.getPrototypeOf(this) as object | null;
    const next = Object.create(proto ?? Object.prototype) as Record<
      string,
      unknown
    >;
    for (const key of Object.getOwnPropertyNames(this)) {
      const value = (this as Record<string, unknown>)[key];
      if (typeof value === "function") continue;
      if (value === null || value === undefined) {
        next[key] = value;
        continue;
      }
      if (shouldShareByReference(value)) {
        next[key] = value;
        continue;
      }
      try {
        next[key] = structuredClone(value);
      } catch {
        next[key] = value;
      }
    }
    return next;
  };
}

/**
 * Return true if the value should be copied by reference rather than via
 * structuredClone. We share:
 *   - Promises (DataCloneError otherwise)
 *   - Class instances whose prototype is NOT Object.prototype / Array.prototype.
 *     (structuredClone of a class instance succeeds but strips the prototype,
 *     so methods like `run()` would disappear from the clone — exactly the
 *     bug we hit with SwarmOrchestrationAgent and A2AClient.)
 */
function shouldShareByReference(value: unknown): boolean {
  if (value instanceof Promise) return true;
  if (typeof value !== "object" || value === null) return false;
  if (Array.isArray(value)) {
    // Share whole array by reference if any element is a class instance,
    // because structuredClone would strip those instances' prototypes.
    return value.some((entry) => isClassInstance(entry));
  }
  return isClassInstance(value);
}

function isClassInstance(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto !== null && proto !== Object.prototype;
}

async function checkAgentCards(urls: string[]): Promise<CardCheck> {
  const failures: { url: string; error: string }[] = [];
  await Promise.all(
    urls.map(async (url) => {
      const base = url.replace(/\/+$/, "");
      let lastErr = "unknown";
      for (const path of CARD_PATHS) {
        try {
          const res = await fetch(`${base}/${path}`, {
            method: "GET",
            headers: { Accept: "application/json" },
            cache: "no-store",
          });
          if (res.ok) return;
          lastErr = `HTTP ${res.status} at /${path}`;
        } catch (err) {
          lastErr = err instanceof Error ? err.message : String(err);
        }
      }
      failures.push({ url, error: lastErr });
    }),
  );
  return failures.length === 0 ? { ok: true } : { ok: false, failures };
}
