# UniswapSwarm

<p align="center">
  <img src="apps/web/public/banner.png" alt="UniswapSwarm" />
</p>

An autonomous AI agent swarm that identifies and executes profitable, low-risk token swaps across **Uniswap V2/V3/V4 and UniswapX** (Ethereum mainnet). Built on top of the **0G Compute Network** for verifiable, decentralised LLM inference and **0G Storage** for on-chain audit trails, with a **CopilotKit + AG-UI / A2A** front-end for live, multi-agent observability and HITL approval.

> **Capital preservation first.** The swarm is tuned to prioritise safety over yield — every trade is researched, planned, risk-scored, strategised, and critiqued before execution. Stablecoin-to-stablecoin swaps (USDC ↔ USDT, DAI ↔ USDC, …) are categorically forbidden by policy at three independent layers.

---

## Architecture

The swarm runs a sequential pipeline of specialised agents that share a common **Blackboard Memory** per cycle. Each agent writes its output to in-process memory that is simultaneously persisted to **0G Storage** as an immutable, on-chain audit trail.

```mermaid
flowchart TB
    subgraph ClientLayer["🖥️ Client Layer"]
        WebUI["Next.js Web App\napps/web\n(CopilotKit + Reown AppKit)"]
    end

    subgraph CopilotRuntime["🧠 CopilotKit Runtime  (in-process, web)"]
        CKRoute["API Route\n/api/copilotkit"]
        A2AMiddleware["A2AMiddlewareAgent\n(@ag-ui/a2a-middleware)"]
        OrchestratorLLM["Orchestration LLM\nGemini (SwarmOrchestrationAgent)"]
    end

    subgraph Orchestrator["⚙️ Orchestrator Server  :4000"]
        Server["Express Server\nserver.ts"]
        OrchestratorCore["SwarmOrchestrator\norchestrator.ts"]
        A2ARouterO["A2A JSON-RPC Router\na2aOrchestrator.ts"]
        ENSReg["ENS Registry\nensRegistry.ts"]
        HistoryMW["DynamoDB History\nhistoryStore.ts"]
        ManagedW["Managed Wallets\nmanagedWallets.ts"]

        subgraph AgentEndpoints["A2A Agent Endpoints  /a2a/agents/*"]
            R["/researcher"]
            PL["/planner"]
            RK["/risk"]
            ST["/strategy"]
            CR["/critic"]
            EX["/executor"]
        end
    end

    subgraph AgentPipeline["🤖 Agent Pipeline  (packages)"]
        ResearchAgent["1️⃣ ResearchAgent\nagent-researcher"]
        PlannerAgent["2️⃣ PlannerAgent\nagent-planner"]
        RiskAgent["3️⃣ RiskAgent\nagent-risk"]
        StrategyAgent["4️⃣ StrategyAgent\nagent-strategy"]
        CriticAgent["5️⃣ CriticAgent\nagent-critic"]
        ExecutorAgent["6️⃣ ExecutorAgent\nagent-executor"]
    end

    subgraph SharedInfra["🌐 Infrastructure"]
        ZGCompute["0G Compute\nLLM inference"]
        ZGStorage["0G Storage\nBlackboardMemory\n(shared session state)"]
        DynamoDB["DynamoDB\nwallet keys + cycle history"]
        ENSChain["ENS on Sepolia\n*.uniswapswarm.eth\ntext[url] / text[name]"]
        Uniswap["Uniswap SwapRouter02\nEthereum mainnet"]
        CoinGecko["CoinGecko API\nmarket data"]
        UniswapPools["Uniswap V2/V3/V4\n+ UniswapX pools"]
        FearGreed["Fear & Greed Index\n+ Reddit/news"]
    end

    %% Web → CopilotKit
    WebUI <-->|"AG-UI protocol  SSE"| CKRoute
    CKRoute --> A2AMiddleware
    A2AMiddleware --> OrchestratorLLM
    OrchestratorLLM -->|"send_message_to_a2a_agent"| AgentEndpoints

    %% Web → Orchestrator direct
    WebUI -->|"SSE  POST /a2a/route/stream\nPOST /agents/*"| Server
    WebUI -->|"GET /managed-wallet/*/ledger\nPOST /fund-ledger"| ManagedW

    %% Orchestrator internals
    Server --> OrchestratorCore
    Server --> A2ARouterO
    Server --> ENSReg
    Server --> HistoryMW

    AgentEndpoints --> OrchestratorCore
    A2ARouterO --> AgentEndpoints

    ENSReg <-->|"read/write text[url]\non-chain"| ENSChain

    %% Pipeline — strict sequential order
    OrchestratorCore --> ResearchAgent
    ResearchAgent -->|"researcher/report"| PlannerAgent
    PlannerAgent -->|"planner/plan"| RiskAgent
    RiskAgent -->|"risk/assessments"| StrategyAgent
    StrategyAgent -->|"strategy/proposal"| CriticAgent
    CriticAgent -->|"critic/critique"| ExecutorAgent

    %% Shared state (blackboard)
    ResearchAgent & PlannerAgent & RiskAgent & StrategyAgent & CriticAgent & ExecutorAgent <-->|"R/W blackboard"| ZGStorage
    ResearchAgent & PlannerAgent & RiskAgent & StrategyAgent & CriticAgent & ExecutorAgent --> ZGCompute

    %% External data
    ResearchAgent --> CoinGecko
    ResearchAgent --> UniswapPools
    ResearchAgent --> FearGreed
    ExecutorAgent --> Uniswap

    %% Persistence
    HistoryMW <--> DynamoDB
    ManagedW <-->|"AES-256-GCM encrypted keys"| DynamoDB

    style ENSChain fill:#4b2eaa,color:#fff
    style ZGCompute fill:#1a6b3c,color:#fff
    style ZGStorage fill:#1a6b3c,color:#fff
    style Uniswap fill:#ff007a,color:#fff
    style OrchestratorLLM fill:#1967d2,color:#fff
    style A2AMiddleware fill:#1967d2,color:#fff
```

### Agent Roles

| Agent          | Package            | Role                                                                                                                                                                                                                                |
| -------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Researcher** | `agent-researcher` | Fetches live Uniswap pool data, CoinGecko market data, Fear & Greed index, Reddit/news narrative signal; detects market narrative (`ai \| safe_haven \| defi \| l2 \| staking \| neutral`); returns ranked `TokenCandidate` objects |
| **Planner**    | `agent-planner`    | Reads Researcher output and produces a structured `TradePlan` with strategy type, constraints, and tasks                                                                                                                            |
| **Risk**       | `agent-risk`       | Scores each candidate (honeypot, low liquidity, MEV risk, …) and flags unsafe tokens                                                                                                                                                |
| **Strategy**   | `agent-strategy`   | Selects the best trade route, sizes the position, and sets slippage/fee parameters                                                                                                                                                  |
| **Critic**     | `agent-critic`     | Reviews the fully assembled plan and approves or rejects it with a confidence score                                                                                                                                                 |
| **Executor**   | `agent-executor`   | Submits the swap via Uniswap's `SwapRouter02` (supports dry-run and simulation-only modes)                                                                                                                                          |

All LLM calls go through `@swarm/compute` (`ZGCompute`) — a thin wrapper around the [0G Serving Broker](https://github.com/0glabs/0g-serving-broker) that auto-manages ledger deposits and provider acknowledgement.

All agent outputs are persisted via `@swarm/memory` (`ZGStorage`) to the [0G Storage network](https://docs.0g.ai) for cross-cycle auditability.

### Goal-Category Routing

Token category handling is now prompt-driven in the Research agent. When the user goal contains category intent (for example: `DeFi`, `L2`, `AI`, `L1`, `RWA`), the Researcher pre-focuses the candidate feed toward matching symbols before ranking.

---

## Monorepo Structure

```
uniswapswarm/
├── apps/
│   ├── orchestrator/                 # Express REST server + cycle runner +
│   │   └── src/
│   │       ├── a2aAgents.ts          #   six standalone A2A JSON-RPC servers
│   │       ├── a2aOrchestrator.ts    #   AG-UI orchestrator wiring
│   │       ├── orchestrator.ts       #   sequential pipeline runner
│   │       └── server.ts             #   REST + SSE endpoints
│   └── web/                          # Next.js + CopilotKit cockpit
│       ├── app/                      #   App Router pages + /api/copilotkit
│       ├── components/
│       │   ├── a2a/                  #     animated MessageToA2A / FromA2A cards
│       │   ├── data/                 #     sidebar cards (plan, risk, strategy, audit)
│       │   ├── forms/                #     HITL: SwapIntentForm
│       │   ├── hitl/                 #     HITL: TradeApprovalCard
│       │   ├── swarm-audit-context.tsx  #   0G storage write fan-in
│       │   └── swarm-chat.tsx        #     CopilotKit actions + chat shell
│       └── lib/                      #   wallet watch, SSE plumbing, agent registry
├── agents/
│   ├── agent-researcher/   # Uniswap pool data, CoinGecko, Fear&Greed, narrative detection,
│   │   └── src/            #   goal-focused token feed, simplified run() + buildTokenFeed()
│   ├── agent-planner/
│   ├── agent-risk/
│   ├── agent-strategy/
│   ├── agent-critic/
│   └── agent-executor/
├── packages/
│   ├── compute/            # ZGCompute — 0G Compute client for agent inference
│   ├── memory/             # BlackboardMemory + ZGStorage — shared state & on-chain audit
│   ├── shared/             # Config (Zod), types, logger, token/stablecoin constants
│   ├── eslint-config/
│   └── typescript-config/
├── scripts/
│   ├── fund-ledger.ts      # Fund / top-up the 0G Compute ledger
│   ├── create-dynamo-tables.ts  # Provision DynamoDB history + wallet tables
│   └── README.md           # Script-level documentation
└── output/
```

Built with [Turborepo](https://turbo.build/) and [pnpm workspaces](https://pnpm.io/workspaces).

---

## Prerequisites

| Tool                  | Version                                                                            |
| --------------------- | ---------------------------------------------------------------------------------- |
| Node.js               | ≥ 18                                                                               |
| pnpm                  | ≥ 9                                                                                |
| A funded 0G wallet    | See [0G docs](https://docs.0g.ai)                                                  |
| Google Gemini API key | For the cockpit orchestrator. [Get a key](https://aistudio.google.com/app/apikey). |

---

## Setup

### 1. Clone and install

```sh
git clone git@github.com:NirajBhattarai/UniswapSwarm.git
cd UniswapSwarm
pnpm install
```

### 2. Configure environment

Copy the example and fill in your keys:

```sh
cp .env.example .env
```

| Variable                    | Required | Description                                                                           |
| --------------------------- | -------- | ------------------------------------------------------------------------------------- |
| `ZG_PRIVATE_KEY`            | **yes**  | Private key of a funded 0G wallet (64-char hex, no `0x`)                              |
| `ZG_CHAIN_RPC`              | no       | 0G EVM RPC (default: `https://evmrpc-testnet.0g.ai`)                                  |
| `ETH_RPC_URL`               | no       | Ethereum mainnet RPC (default: `https://eth.llamarpc.com`)                            |
| `ZG_COMPUTE_RPC`            | no       | 0G Compute indexer RPC (default: `https://indexer-storage-testnet-turbo.0g.ai`)       |
| `ZG_STORAGE_RPC`            | no       | 0G Storage RPC (default: `https://evmrpc-testnet.0g.ai`)                              |
| `ZG_INDEXER_RPC`            | no       | 0G Storage indexer RPC (default: `https://indexer-storage-testnet-turbo.0g.ai`)       |
| `ZG_FLOW_CONTRACT`          | no       | 0G Flow contract address (default: `0xbD2C3F0E65eDF5582141C35969d66e205E00C9c8`)      |
| `UNISWAP_API_KEY`           | no       | Uniswap Trading API key (https://developers.uniswap.org/dashboard)                    |
| `COINGECKO_API_KEY`         | no       | CoinGecko API key — free demo key or pro key (https://www.coingecko.com/en/api)       |
| `ALCHEMY_API_KEY`           | no       | Enables full ERC-20 wallet holdings discovery (fallback is known-token Multicall)     |
| `MAX_SLIPPAGE_PCT`          | no       | Maximum swap slippage % (default: `1.5`)                                              |
| `MAX_POSITION_USDC`         | no       | Maximum position size in USDC (default: `50`)                                         |
| `MIN_LIQUIDITY_USD`         | no       | Minimum pool liquidity required (default: `100000`)                                   |
| `MAX_GAS_GWEI`              | no       | Gas price ceiling in Gwei (default: `30`)                                             |
| `RISK_SCORE_THRESHOLD`      | no       | Minimum risk score to proceed (0–100, default: `70`)                                  |
| `DRY_RUN`                   | no       | `true` to simulate swaps without submitting on-chain (default: `true`)                |
| `SIMULATION_ONLY`           | no       | Extra execution guard. If `true`, forces simulation even when `DRY_RUN=false`         |
| `CYCLE_INTERVAL_MS`         | no       | Milliseconds between autonomous cycles (default: `300000` = 5 min)                    |
| `PORT`                      | no       | REST server port (default: `4000`)                                                    |
| `DYNAMODB_REGION`           | no       | AWS region for optional history persistence (e.g. `us-east-1`)                        |
| `DYNAMODB_HISTORY_TABLE`    | no       | DynamoDB table name for persisted session/cycle history                               |
| `DYNAMODB_HISTORY_GSI_USER` | no       | User-index GSI name for history queries (default: `GSI1`)                             |
| `AWS_ACCESS_KEY_ID`         | no       | AWS access key ID used by Dynamo history client (optional; IAM role/chain also works) |
| `AWS_SECRET_ACCESS_KEY`     | no       | AWS secret access key paired with `AWS_ACCESS_KEY_ID`                                 |
| `AWS_SESSION_TOKEN`         | no       | AWS session token for temporary credentials (optional)                                |
| `DYNAMODB_WALLETS_TABLE`    | no       | DynamoDB table name for AES-256-GCM-encrypted managed wallet keys                    |
| `WALLET_ENCRYPTION_KEY`     | no       | 64-char hex key (32 bytes) used to AES-256-GCM encrypt/decrypt managed wallet private keys. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `ZG_INFERENCE_MODEL`        | no       | Override the 0G inference model (e.g. `qwen/qwen-2.5-7b-instruct`). Required on local deployments where the default model is unsupported. |

#### CopilotKit cockpit / A2A integration

| Variable                             | Required        | Description                                                                                               |
| ------------------------------------ | --------------- | --------------------------------------------------------------------------------------------------------- |
| `GOOGLE_GENERATIVE_AI_API_KEY`       | **for web app** | Gemini API key. Aliases `GOOGLE_API_KEY` and `GEMINI_API_KEY` are also accepted as fallbacks.             |
| `COPILOTKIT_MODEL`                   | no              | Gemini model used by the orchestrator (default: `gemini-2.5-flash`).                                      |
| `NEXT_PUBLIC_COPILOTKIT_RUNTIME_URL` | no              | Frontend → CopilotKit runtime URL (default: `/api/copilotkit`).                                           |
| `NEXT_PUBLIC_ORCHESTRATOR_URL`       | no              | Frontend → orchestrator REST/A2A base URL (default: `http://localhost:4000`).                             |
| `NEXT_PUBLIC_REOWN_PROJECT_ID`       | no              | Reown AppKit project ID for wallet connect/signature flows in the web UI.                                 |
| `A2A_PUBLIC_BASE_URL`                | no              | Public URL embedded in agent cards. Defaults to `http://localhost:${PORT}`.                               |
| `ORCHESTRATOR_URL`                   | no              | Base URL for A2A agent endpoints (default: `http://localhost:4000`). All agents are accessible as routes. |
| `RESEARCHER_AGENT_URL`, etc.         | no              | Per-agent URL overrides for the web app. Defaults to `${ORCHESTRATOR_URL}/a2a/agents/<agent-id>`.         |

#### ENS Registry

| Variable                  | Required | Description                                                                       |
| ------------------------- | -------- | --------------------------------------------------------------------------------- |
| `ENS_RPC_URL`             | no       | Sepolia JSON-RPC URL (required for any ENS read/write)                            |
| `ENS_OWNER_PRIVATE_KEY`   | no       | Owner key for `uniswapswarm.eth` — used by `scripts/setup-ens.ts`                 |
| `ENS_RECORDS_PRIVATE_KEY` | no       | Approved delegate key — preferred for CI and the orchestrator's self-registration |

### 3. Fund the 0G Compute ledger

Before first use, top up your 0G Compute ledger (target: 5 OG, keeps 1 OG reserve in wallet):

```sh
pnpm tsx scripts/fund-ledger.ts
```

### 4. Goal-based token routing

No model fine-tuning step is required. Category intent is derived directly from user goals in the Research agent prompt flow.

See [`scripts/README.md`](./scripts/README.md) for available operational scripts.

### 5. Build

```sh
pnpm build
```

---

## Running

### REST server (recommended)

```sh
pnpm --filter orchestrator start
```

The server starts on port `4000` by default (override with `PORT` env var).

#### Full-pipeline endpoints

| Method | Path                | Description                                               |
| ------ | ------------------- | --------------------------------------------------------- |
| `GET`  | `/health`           | Liveness check (`{ status, running }`)                    |
| `POST` | `/a2a/route/stream` | Run intent-routed agent pipeline with SSE event streaming |

#### Per-agent endpoints

Each agent can also be invoked individually. All support both a blocking JSON form and a Server-Sent Events stream form.

| Method | Path                               | Body                   | Description                                   |
| ------ | ---------------------------------- | ---------------------- | --------------------------------------------- |
| `POST` | `/agents/researcher`               | `{ goal?: string }`    | Run Researcher agent (JSON)                   |
| `POST` | `/agents/researcher/stream`        | `{ goal?: string }`    | Run Researcher agent (SSE)                    |
| `POST` | `/agents/researcher/prices`        | `{ tokens: string[] }` | Fetch live prices for a list of token symbols |
| `POST` | `/agents/researcher/prices/stream` | `{ tokens: string[] }` | Same, as SSE                                  |
| `POST` | `/agents/researcher/market`        | `{ tokens: string[] }` | Fetch CoinGecko 24h market data               |
| `POST` | `/agents/planner`                  | `{ goal?: string }`    | Run Planner agent (JSON)                      |
| `POST` | `/agents/planner/stream`           | `{ goal?: string }`    | Run Planner agent (SSE)                       |
| `POST` | `/agents/risk`                     | —                      | Run Risk agent (reads memory)                 |
| `POST` | `/agents/risk/stream`              | —                      | Run Risk agent (SSE)                          |
| `POST` | `/agents/strategy`                 | —                      | Run Strategy agent (reads memory)             |
| `POST` | `/agents/strategy/stream`          | —                      | Run Strategy agent (SSE)                      |
| `POST` | `/agents/critic`                   | —                      | Run Critic agent (reads memory)               |
| `POST` | `/agents/critic/stream`            | —                      | Run Critic agent (SSE)                        |
| `POST` | `/agents/executor`                 | —                      | Run Executor agent (reads memory)             |
| `POST` | `/agents/executor/stream`          | —                      | Run Executor agent (SSE)                      |

#### State endpoints

| Method | Path                                        | Description                                                                                    |
| ------ | ------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `GET`  | `/memory`                                   | Dump blackboard memory (`?sessionId=...` to scope, no query = all sessions)                    |
| `GET`  | `/history`                                  | Cycle history for a session (DynamoDB if configured, else in-process)                          |
| `GET`  | `/history/sessions`                         | List sessions by user (`?walletAddress=` or `x-wallet-address` header; `?limit=` optional)    |
| `GET`  | `/history/sessions/:sessionId`              | Fetch a single persisted session record                                                        |
| `GET`  | `/history/sessions/:sessionId/cycles`       | List all cycles within a session (`?limit=` optional)                                          |
| `GET`  | `/latest`                                   | Most recent completed cycle state                                                              |

#### Wallet endpoints

| Method | Path                                               | Body / Params           | Description                                                                               |
| ------ | -------------------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------- |
| `POST` | `/wallet-watch/stream`                             | `{ walletAddress, prompt? }` | Composite researcher + planner SSE stream focused on a wallet's holdings                 |
| `GET`  | `/managed-wallet/:connectedAddress/ledger`         | —                       | Decrypt managed key, query 0G Compute ledger balance, return `{ ledgerBalance, ledgerLow }` |
| `POST` | `/managed-wallet/:connectedAddress/fund-ledger`    | `{ amount: number }`    | Deposit OG tokens into the 0G Compute ledger for the managed wallet (min 5 OG enforced)  |

#### Discovery endpoints

| Method | Path                           | Description                                                          |
| ------ | ------------------------------ | -------------------------------------------------------------------- |
| `GET`  | `/api/ens/agents`              | Resolve all agent ENS records from Sepolia (`chain`, `chainId`, `agents[]`) |
| `GET`  | `/.well-known/agent-card.json` | A2A agent card for the orchestrator (A2A JSON-RPC discovery)         |
| `POST` | `/a2a/jsonrpc`                 | A2A JSON-RPC endpoint (full pipeline via A2A protocol)               |
| `POST` | `/a2a/rest`                    | A2A REST endpoint (same pipeline, REST variant)                      |

### Orchestrator dev server (CLI)

```sh
pnpm --filter @swarm/orchestrator dev
```

### CopilotKit A2A web cockpit

The `apps/web` Next.js app implements the same multi-agent UI pattern as
[CopilotKit/a2a-travel](https://github.com/CopilotKit/a2a-travel), but tailored to
the Uniswap swap pipeline. Each Uniswap Swarm agent is exposed as its own
A2A JSON-RPC server, and a `A2AMiddlewareAgent` wraps a Gemini-backed
orchestration agent and auto-injects the `send_message_to_a2a_agent` tools.

```
apps/web (CopilotKit + AG-UI)
   │
   │  AG-UI Protocol (in-process)
   ▼
SwarmOrchestrationAgent (Gemini)
   │
   │  send_message_to_a2a_agent tool (injected by A2AMiddlewareAgent)
   ▼
┌──────────────┬────────────┬──────────────┬──────────────┬────────────┬──────────────┐
│ Researcher   │ Planner    │ Risk         │ Strategy     │ Critic     │ Executor     │
│ Port 4000    │ Port 4000  │ Port 4000    │ Port 4000    │ Port 4000  │ Port 4000    │
│ /a2a/agents/ │ /a2a/      │ /a2a/agents/ │ /a2a/agents/ │ /a2a/      │ /a2a/agents/ │
│ researcher   │ agents/    │ risk         │ strategy     │ agents/    │ executor     │
│              │ planner    │              │              │ critic     │              │
└──────────────┴────────────┴──────────────┴──────────────┴────────────┴──────────────┘
       (all agents run on same port with route-based A2A JSON-RPC endpoints)
```

```sh
# Run orchestrator + 6 A2A agent servers + Next.js web UI in parallel
pnpm dev
```

Then open http://localhost:3000.

#### What you see in the UI

- **Animated A2A handoff cards.** Every `send_message_to_a2a_agent` call
  renders as a green "orchestrator → agent" card with a flowing arrow,
  pulsing badge, and bouncing ellipsis while the request is in flight,
  followed by a blue "agent → orchestrator" response card sliding in from
  the right when complete.
- **0G Storage audit chips.** Each response card lists the keys the agent
  wrote to 0G Storage along with truncated root hashes and byte sizes
  (`risk/assessments → 0x8ad6…ba6d3 · 943 B`). The same data is aggregated
  into a dedicated **Storage Audit Trail** card in the sidebar, fed via a
  `SwarmAuditContext` that fan-ins writes from every streamed message.
- **Sidebar data cards.** Structured JSON from each agent is parsed and
  rendered as first-class cards: candidate list, plan tasks, per-token
  risk score with severity-ranked flags, strategy proposal (route, fee
  tier, slippage), critic verdict, and execution receipt.
- **Defensive task rendering.** If the orchestrator LLM regresses and
  pastes a previous agent's JSON envelope into the next `task`, the UI
  detects the JSON shape and renders a compact "📎 Forwarded payload"
  pill instead of dumping braces into the chat.
- **Two HITL flows** mirroring the a2a-travel trip-requirements / budget
  approval pattern:
  - `gather_swap_intent` — pre-trade form (token-in, token-out, USD size,
    risk level). Used **rarely** — only when the user opens the chat with
    a bare greeting. Any actionable prompt ("find safe trades", "swap X
    for Y") goes straight to the Researcher.
  - `request_trade_approval` — post-critic approval card. The Executor
    will not sign without an explicit user click here.

Required environment variables (see `.env.example`):

```env
GOOGLE_GENERATIVE_AI_API_KEY=...   # or GOOGLE_API_KEY / GEMINI_API_KEY
COPILOTKIT_MODEL=gemini-2.5-flash
# All agents run on port 4000 with route-based endpoints
# ORCHESTRATOR_URL=http://localhost:4000  # optional override
```

---

## How a Cycle Works

Every agent writes its output to the shared `BlackboardMemory`. Each write is simultaneously uploaded to **0G Storage** as an immutable root hash, forming an on-chain audit trail. Every downstream agent reads prior outputs from that same memory via `memory.contextFor()`.

1. **Researcher** — refactored to a single `run()` + `buildTokenFeed()` flow:
   - Detects the current market narrative (`ai | safe_haven | defi | l2 | staking | neutral`) from Fear & Greed index and Reddit/news headlines via `impit`
   - Fetches CoinGecko 24h market data for wallet tokens + narrative-focused candidates
   - Fetches live multi-protocol Uniswap pool snapshots (V2/V3/V4/UniswapX) for each candidate
   - Applies **goal-first generic rules** in the system prompt (replaced hardcoded per-narrative token lists with dynamic focus based on the user's stated goal)
   - Writes `researcher/report` to shared memory

2. **Planner** reads `researcher/report` from memory and produces a `TradePlan` (strategy type, conservative constraints, per-agent task list), writing `planner/plan`.

3. **Risk Agent** reads `planner/plan` + `researcher/report` and runs each candidate through honeypot detection, ownership concentration checks, MEV exposure scoring, and more — writing `risk/assessments`.

4. **Strategy Agent** reads all prior memory, picks the highest-scoring safe candidate, and crafts an exact swap calldata spec (`TradeStrategy`), writing `strategy/proposal`.

5. **Critic Agent** reads all memory entries, performs a holistic review, and either approves or rejects with a confidence score + issues list — writing `critic/critique`.

6. **Executor** — if the Critic approved — executes through Uniswap Trading API (`check_approval` → `quote` → `swap`). Runtime safety defaults to simulation because `DRY_RUN=true` by default. The optional `SIMULATION_ONLY` guard can additionally force simulation regardless of `DRY_RUN`.

---

## Shared KV Store — How Agents Communicate in Real-Time

All six agents share **one `BlackboardMemory` instance** per orchestrator session. The orchestrator constructs it once and injects it into every agent constructor via dependency injection — so every read and write operates on the exact same in-process `Map<string, MemoryEntry>`. There is no network hop or serialisation round-trip between agents within a cycle.

### Architecture — KV store internals

```mermaid
flowchart TD
    subgraph SESSION["Session Context  (one per sessionId)"]
        direction TB

        subgraph BB["BlackboardMemory  —  in-process Map&lt;string, MemoryEntry&gt;"]
            direction LR
            K1["researcher/report\n(ResearchReport)"]
            K2["researcher/wallet_holdings\n(WalletHolding[])"]
            K3["planner/plan\n(TradePlan)"]
            K4["risk/assessments\n(RiskAssessment[])"]
            K5["strategy/proposal\n(TradeStrategy)"]
            K6["critic/critique\n(Critique)"]
            K7["executor/result\n(ExecutionResult)"]
        end

        subgraph AGENTS["Agents  (share same BB reference)"]
            R["🔬 Researcher"]
            P["📋 Planner"]
            Ri["⚠️ Risk"]
            S["📈 Strategy"]
            C["🧐 Critic"]
            E["⚡ Executor"]
        end
    end

    subgraph ZG["0G Network  (async, best-effort)"]
        ZGS["0G Storage\nJSON blob upload"]
        ZGH["Root Hash (CID)\nreturned per write"]
    end

    subgraph UI["UI / Orchestrator"]
        ORC["SwarmOrchestrator\ncreates BB once, injects into all agents"]
        STREAM["SSE stream\nreadAll() → client"]
    end

    %% Orchestrator wires everything
    ORC -->|"new BlackboardMemory(zgStorage, 'sessions/<id>')"| BB
    ORC --> R & P & Ri & S & C & E

    %% Sequential write chain (agents run in order)
    R -->|"write('researcher/report')\nwrite('researcher/wallet_holdings')"| K1 & K2
    P -->|"contextFor() reads K1\nwrite('planner/plan')"| K1
    P -->|write| K3
    Ri -->|"readValue(K1, K3)\nwrite('risk/assessments')"| K1 & K3
    Ri -->|write| K4
    S -->|"contextFor() reads K1–K4\nwrite('strategy/proposal')"| K1 & K3 & K4
    S -->|write| K5
    C -->|"contextFor() reads K1–K5\nwrite('critic/critique')"| K1 & K3 & K4 & K5
    C -->|write| K6
    E -->|"readValue(K5, K6)\nwrite('executor/result')"| K5 & K6
    E -->|write| K7

    %% Every write also fans out to 0G async
    K1 & K2 & K3 & K4 & K5 & K6 & K7 -->|"storage.store()\nsessions/<id>/<key>"| ZGS
    ZGS --> ZGH
    ZGH -->|"stored in MemoryEntry.hash"| BB

    %% UI reads
    BB -->|"readAll() — chronological"| STREAM

    %% Styling
    style BB fill:#dbeafe,stroke:#2563eb,color:#1e3a8a
    style AGENTS fill:#ede9fe,stroke:#7c3aed,color:#3b0764
    style ZG fill:#dcfce7,stroke:#16a34a,color:#14532d
    style SESSION fill:#f8fafc,stroke:#94a3b8,color:#334155
    style UI fill:#fef3c7,stroke:#d97706,color:#78350f
```

### Write lifecycle

```mermaid
flowchart LR
    A["Agent calls\nmemory.write(key, …)"] --> B["cache.set(key, entry)\nin-process Map — O(1)"]
    B --> C{"zgStorage\npresent?"}
    C -- yes --> D["storage.store()\n0G Storage upload"]
    D --> E["returns rootHash\n(0G CID)"]
    E --> F["entry.hash = rootHash"]
    C -- no / error --> G["computeLocalHash()\nSHA-256 of JSON"]
    G --> F
    F --> H["MemoryEntry\n{ key, agentId, role,\n  value, hash, ts }"]
    H --> I["Next agent reads\nO(1) from same Map"]
    H --> J["UI stream\nreadAll() → SSE"]
```

### Agent-to-agent read patterns

```mermaid
flowchart TD
    subgraph READS["Two read APIs"]
        direction LR
        RV["readValue&lt;T&gt;(key)\n──────────────\nTyped structured access\nReturns value cast to T\nUsed for programmatic logic\ne.g. check critique.approved"]
        CF["contextFor(excludeKey)\n──────────────\nLLM prompt injection\nFormats ALL prior entries\nas Markdown block\nExcludes own write slot"]
    end

    K1R["researcher/report"] --> RV & CF
    K3R["planner/plan"] --> RV & CF
    K4R["risk/assessments"] --> RV & CF
    K5R["strategy/proposal"] --> RV & CF
    K6R["critic/critique"] --> RV

    RV -->|"agent uses value\nin business logic"| BL["if (!critique.approved) return"]
    CF -->|"appended to\nsystem prompt"| LLM["LLM call\n(Gemini / 0G Compute)"]

    style READS fill:#ede9fe,stroke:#7c3aed,color:#3b0764
```

### Temporal write order

```mermaid
timeline
    title Blackboard KV — write timeline within one cycle
    section t₀ Researcher
        researcher/report        : ResearchReport — market data, pool snapshots, narrative
        researcher/wallet_holdings : WalletHolding[] — current portfolio
    section t₁ Planner
        planner/plan             : TradePlan — strategy type, constraints, task list
    section t₂ Risk
        risk/assessments         : RiskAssessment[] — honeypot, concentration, MEV scores
    section t₃ Strategy
        strategy/proposal        : TradeStrategy — exact swap calldata spec
    section t₄ Critic
        critic/critique          : Critique — approved flag, confidence, issues list
    section t₅ Executor
        executor/result          : ExecutionResult — tx hash or simulation receipt
```

### Key design decisions

| Decision                               | Detail                                                                                                                                                                                                                                                                                                        |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Single shared instance**             | One `BlackboardMemory` per session (see `orchestrator.ts → createSessionContext`). Every agent holds a reference to the same object — writes are immediately visible to subsequent agents with zero latency.                                                                                                  |
| **In-process Map, not a remote store** | The backing `cache` is a plain `Map<string, MemoryEntry>`. Reads are synchronous and O(1). There is no Redis, no database, no inter-process call between agents within a cycle.                                                                                                                               |
| **Namespaced keys**                    | Keys follow `<agentId>/<slot>` (e.g. `researcher/report`). The `BlackboardMemory` instance adds a session namespace prefix (`sessions/<sessionId>/`) before calling 0G Storage so on-chain blobs are scoped per session. In-process reads use the short key without the prefix.                               |
| **Async 0G Storage write**             | Every `memory.write()` fires `storage.store()` concurrently, awaits the root hash, and falls back to a local SHA-256 if 0G is unreachable — so a storage outage never stalls the agent pipeline.                                                                                                              |
| **LLM context injection**              | `memory.contextFor(excludeKey)` formats all prior entries as a Markdown block (`## Shared swarm memory (previous agents)` / `### <role>\n<payload>`) and appends it to the agent's system/user prompt. Agents pass their own write key as `excludeKey` so they never read their own (yet-to-be-written) slot. |
| **Typed reads**                        | `memory.readValue<T>(key)` returns the stored value cast to `T` (or `undefined`). Agents use this for structured programmatic access (e.g. `memory.readValue<Critique>("critic/critique")`), while `contextFor()` is used for raw LLM prompt assembly.                                                        |
| **Cross-session isolation**            | Each session has its own `SessionContext` (and therefore its own `BlackboardMemory` Map). Sessions are stored in `orchestrator.sessionContexts: Map<sessionId, SessionContext>` and never share memory.                                                                                                       |

### KV schema

| Key                          | Written by | TypeScript type    | Read by                                   |
| ---------------------------- | ---------- | ------------------ | ----------------------------------------- |
| `researcher/report`          | Researcher | `ResearchReport`   | Planner, Risk, Strategy, Critic, Executor |
| `researcher/wallet_holdings` | Researcher | `WalletHolding[]`  | Executor                                  |
| `planner/plan`               | Planner    | `TradePlan`        | Risk, Strategy, Critic                    |
| `risk/assessments`           | Risk       | `RiskAssessment[]` | Strategy, Critic                          |
| `strategy/proposal`          | Strategy   | `TradeStrategy`    | Critic, Executor                          |
| `critic/critique`            | Critic     | `Critique`         | Executor                                  |
| `executor/result`            | Executor   | `ExecutionResult`  | Orchestrator (UI stream)                  |

### Reading memory in code

```ts
// Typed read — structured access (agent-to-agent data)
const critique = this.memory.readValue<Critique>("critic/critique");

// LLM context block — appended to system/user prompt
const context = this.memory.contextFor("strategy/proposal");
// → "## Shared swarm memory (previous agents)\n### Researcher\n…\n### Planner\n…"

// Write — persists to in-process Map + fires async 0G Storage upload
await this.memory.write(
  "strategy/proposal",
  "strategy",
  "Strategy Agent",
  payload,
);

// Dump all entries (chronological) — used by orchestrator for UI streaming
const all = this.memory.readAll(); // MemoryEntry[]
```

---

## ENS Agent Registry

ENS (`uniswapswarm.eth` on **Sepolia**) is the single source of truth for agent endpoint discovery. Any caller that knows an agent's ENS name can find its live A2A URL without any other configuration.

### On-chain structure

Each agent has an ENS subdomain with two text records:

| ENS name                      | `text[url]`                            | `text[name]`       |
| ----------------------------- | -------------------------------------- | ------------------ |
| `researcher.uniswapswarm.eth` | `https://<host>/a2a/agents/researcher` | `Researcher Agent` |
| `planner.uniswapswarm.eth`    | `https://<host>/a2a/agents/planner`    | `Planner Agent`    |
| `risk.uniswapswarm.eth`       | `https://<host>/a2a/agents/risk`       | `Risk Agent`       |
| `strategy.uniswapswarm.eth`   | `https://<host>/a2a/agents/strategy`   | `Strategy Agent`   |
| `critic.uniswapswarm.eth`     | `https://<host>/a2a/agents/critic`     | `Critic Agent`     |
| `executor.uniswapswarm.eth`   | `https://<host>/a2a/agents/executor`   | `Executor Agent`   |

The subdomain names and contract addresses are defined once in [`packages/shared/src/constants.ts`](./packages/shared/src/constants.ts) (`AGENT_ENS_NAMES`, `ENS_CONTRACTS_BY_CHAIN`) and imported everywhere.

### Lifecycle

```mermaid
sequenceDiagram
    participant Dev as Developer
    participant Setup as scripts/setup-ens.ts
    participant ENS as ENS on Sepolia
    participant Orch as Orchestrator (startup)
    participant Caller as External Caller

    Dev->>Setup: npm run setup-ens
    Setup->>ENS: setSubnodeRecord() — create subnames
    Setup->>ENS: setAddr() + setText(name) + setText(url)

    Orch->>ENS: publishAgentUrlsToEns(A2A_PUBLIC_BASE_URL)
    Note over Orch,ENS: writes text[url] = baseUrl/a2a/agents/<id><br/>for every agent — idempotent, skips unchanged

    Orch->>ENS: resolveAgentRegistry()
    ENS-->>Orch: addr + text[name] + text[url] per agent
    Note over Orch: cached in-process<br/>exposed at GET /api/ens/agents

    Caller->>ENS: getResolver(name) → getText("url")
    ENS-->>Caller: live A2A endpoint URL
    Caller->>Orch: A2A JSON-RPC to resolved URL
```

### How it's used in code

| Location                                                                         | What it does                                                                                                                 |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| [`scripts/setup-ens.ts`](./scripts/setup-ens.ts)                                 | **One-time setup** — creates subnames, sets `addr`, `text[name]`, and initial `text[url]` records                            |
| [`scripts/approve-ens-delegate.ts`](./scripts/approve-ens-delegate.ts)           | Approves a delegate key so CI can update records without the owner key                                                       |
| [`apps/orchestrator/src/ensRegistry.ts`](./apps/orchestrator/src/ensRegistry.ts) | `publishAgentUrlsToEns()` — **self-registration** at startup; `resolveAgentRegistry()` — **discovery** with in-process cache |
| [`apps/orchestrator/src/index.ts`](./apps/orchestrator/src/index.ts)             | Calls both functions at boot; `publishAgentUrlsToEns` only runs when `A2A_PUBLIC_BASE_URL` is set                            |
| [`apps/orchestrator/src/server.ts`](./apps/orchestrator/src/server.ts)           | `GET /api/ens/agents` — exposes resolved records (chain, chainId, agents[]) to dashboards                                    |
| [`apps/orchestrator/src/a2aAgents.ts`](./apps/orchestrator/src/a2aAgents.ts)     | Each `AgentDescriptor` carries its `ensName` for card metadata                                                               |
| [`scripts/call-agent.ts`](./scripts/call-agent.ts)                               | Dev script — resolves `text[url]` directly from ENS then sends an A2A JSON-RPC message                                       |

### Required env vars

| Variable                  | Description                                                                       |
| ------------------------- | --------------------------------------------------------------------------------- |
| `ENS_RPC_URL`             | Sepolia JSON-RPC URL (required for any ENS read/write)                            |
| `ENS_OWNER_PRIVATE_KEY`   | Owner key for `uniswapswarm.eth` — used by `setup-ens.ts`                         |
| `ENS_RECORDS_PRIVATE_KEY` | Approved delegate key — preferred for CI and the orchestrator's self-registration |
| `A2A_PUBLIC_BASE_URL`     | Public base URL written into `text[url]` on each agent's subname at startup       |

> **ENS is discovery-only.** Once a URL is resolved, agents communicate over standard HTTP using the A2A JSON-RPC protocol. ENS adds zero latency to the hot path — `resolveAgentRegistry()` results are cached for the lifetime of the process.

### Setup commands

```sh
# 1. Create subnames + set initial records (owner key required)
npm run setup-ens

# 2. Approve a delegate so CI / orchestrator can update records without the owner key
npm run approve-ens-delegate

# 3. Call any agent directly via its ENS-resolved URL (dev / smoke-test)
npm run call-agent -- researcher "Find top ETH pools"
npm run call-agent -- planner   "Plan a conservative ETH/USDC swap"
```

---

## Safety Policies

### Stablecoin → stablecoin swaps are forbidden

The trade always starts from a USD-pegged token (typically USDC), so a
stable `tokenOut` (USDT, DAI, FRAX, BUSD, FDUSD, PYUSD, USDe, USDS, …) is
a 1:1 swap with no economic upside that only burns gas and slippage. The
swarm enforces this at **three independent layers** so that even a buggy
LLM completion cannot produce one:

| Layer      | Where                                                                          | Behaviour                                                                                                                                                               |
| ---------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Researcher | `agents/agent-researcher/src/core/prompts.ts` + `formatters/researchPrompt.ts` | System prompt forbids stablecoin candidates, post-LLM filter drops anything `isStablecoin({symbol, address})` returns true for.                                         |
| Strategy   | `agents/agent-strategy/src/StrategyAgent.ts`                                   | Stablecoins are stripped from the candidate pool before the LLM sees it; if the LLM still emits a stable `tokenOut`, the agent forces the synthetic USDC→WETH fallback. |
| Critic     | `agents/agent-critic/src/CriticAgent.ts`                                       | Hard veto: any proposal where both `tokenIn` and `tokenOut` are stablecoins is rejected with confidence=100.                                                            |

The canonical stablecoin set lives in
[`packages/shared/src/constants.ts`](./packages/shared/src/constants.ts)
and is exposed as `STABLECOIN_SYMBOLS`, `STABLECOIN_ADDRESSES`, and
`isStablecoin({ symbol, address })`.

### Other built-in safeguards

- `maxSlippagePct` is hard-clamped after LLM inference; the LLM cannot exceed the configured plan ceiling.
- The Risk Agent emits typed `RiskFlag[]` with severity (`low | medium | high | critical`); any `critical` flag forces a Critic rejection.
- The Executor checks both `DRY_RUN` and `SIMULATION_ONLY`; any true value keeps execution in simulation mode.

---

## Recent Changes

### ResearchAgent refactor

- `run()` simplified — removed 4 dead methods, extracted `buildTokenFeed()` for cleaner narrative-driven candidate assembly
- `core/prompts.ts` — system prompt now uses **goal-first generic rules** instead of hardcoded per-narrative token lists; the active user goal is injected at call time
- `services/index.ts` — removed stale `fetchGoalFocusSymbols` export
- `services/coinGeckoMarket.ts` — updated market data fetch to align with new token feed structure
- `services/poolSnapshots.ts` — fixed edge-case handling for missing pool data

### Shared package (`packages/shared`)

- `constants.ts` — centralized token/stablecoin registries and category mappings used by the agents
- `config.ts` — runtime config for 0G compute/storage, web routing, and optional provider overrides

### Scripts

| Script           | What's new                            |
| ---------------- | ------------------------------------- |
| `fund-ledger.ts` | Unchanged — top-up helper             |
| `README.md`      | Documents currently supported scripts |

---

## Development

```sh
# Type-check all packages
pnpm check-types

# Format every TS / TSX / MD file with Prettier
pnpm format

# Lint
pnpm lint

# Build with watch (individual package)
pnpm --filter @swarm/compute dev

# Run orchestrator + 6 A2A servers + Next.js cockpit in parallel
pnpm dev
```

---

## Key Dependencies

### Runtime — agents & orchestrator

- [`@0glabs/0g-serving-broker`](https://www.npmjs.com/package/@0glabs/0g-serving-broker) — 0G Compute paymaster & inference client
- [`@0gfoundation/0g-ts-sdk`](https://www.npmjs.com/package/@0gfoundation/0g-ts-sdk) — 0G Storage SDK (file upload / root hash)
- [`ethers`](https://www.npmjs.com/package/ethers) v6 — Ethereum wallet & provider
- [`impit`](https://www.npmjs.com/package/impit) — TLS-fingerprint spoofer for bot-detection bypass (Fear & Greed, Reddit)
- [`zod`](https://www.npmjs.com/package/zod) — Runtime config & env validation
- [`express`](https://www.npmjs.com/package/express) — REST API server
- [`uuid`](https://www.npmjs.com/package/uuid) — Cycle ID generation

### Cockpit — `apps/web`

- [`@copilotkit/react-core`](https://www.npmjs.com/package/@copilotkit/react-core) + [`@copilotkit/react-ui`](https://www.npmjs.com/package/@copilotkit/react-ui) — chat shell, tool actions, HITL renderers
- [`@copilotkit/runtime`](https://www.npmjs.com/package/@copilotkit/runtime) — Next.js API route adapter
- [`@ag-ui/a2a-middleware`](https://www.npmjs.com/package/@ag-ui/a2a-middleware) — bridges AG-UI tool calls to A2A JSON-RPC
- [`@ai-sdk/google`](https://www.npmjs.com/package/@ai-sdk/google) — Gemini provider for the orchestrator
- [`next`](https://www.npmjs.com/package/next) 16 + [`react`](https://www.npmjs.com/package/react) 19 + [`tailwindcss`](https://www.npmjs.com/package/tailwindcss) v4

---

## License

MIT
