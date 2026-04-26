# UniswapSwarm

An autonomous AI agent swarm that identifies and executes profitable, low-risk token swaps across **Uniswap V2/V3/V4 and UniswapX** (Ethereum mainnet). Built on top of the **0G Compute Network** for verifiable, decentralised LLM inference and **0G Storage** for on-chain audit trails.

> **Capital preservation first.** The swarm is tuned to prioritise safety over yield — every trade is researched, planned, risk-scored, strategised, and critiqued before execution.

---

## Architecture

The swarm runs a sequential pipeline of specialised agents that share a common **Blackboard Memory** per cycle. Each agent writes its output to in-process memory that is simultaneously persisted to **0G Storage** as an immutable, on-chain audit trail.

```
Researcher → Planner → Risk → Strategy → Critic → Executor
```

| Agent          | Package            | Role                                                                                                  |
| -------------- | ------------------ | ----------------------------------------------------------------------------------------------------- |
| **Researcher** | `agent-researcher` | Fetches live multi-protocol Uniswap pool data, CoinGecko market data, Fear & Greed index, Reddit/news narrative signal, and returns ranked `TokenCandidate` objects |
| **Planner**    | `agent-planner`    | Reads Researcher output and produces a structured `TradePlan` with strategy type, constraints, and tasks |
| **Risk**       | `agent-risk`       | Scores each candidate (honeypot, low liquidity, MEV risk, …) and flags unsafe tokens                  |
| **Strategy**   | `agent-strategy`   | Selects the best trade route, sizes the position, and sets slippage/fee parameters                    |
| **Critic**     | `agent-critic`     | Reviews the fully assembled plan and approves or rejects it with a confidence score                   |
| **Executor**   | `agent-executor`   | Submits the swap via Uniswap's `SwapRouter02` (supports dry-run and simulation-only modes)            |

All LLM calls go through `@swarm/compute` (`ZGCompute`) — a thin wrapper around the [0G Serving Broker](https://github.com/0glabs/0g-serving-broker) that auto-manages ledger deposits and provider acknowledgement.

All agent outputs are persisted via `@swarm/memory` (`ZGStorage`) to the [0G Storage network](https://docs.0g.ai) for cross-cycle auditability.

---

## Monorepo Structure

```
uniswapswarm/
├── apps/
│   └── orchestrator/       # Express REST server + cycle runner
├── agents/
│   ├── agent-researcher/   # Uniswap Trading API, CoinGecko, Fear&Greed, narrative detection
│   ├── agent-planner/
│   ├── agent-risk/
│   ├── agent-strategy/
│   ├── agent-critic/
│   └── agent-executor/
├── packages/
│   ├── compute/            # ZGCompute — 0G Compute Network client
│   ├── memory/             # BlackboardMemory + ZGStorage — shared agent state & on-chain audit
│   ├── shared/             # Config (Zod-validated), types, logger, constants
│   ├── eslint-config/
│   └── typescript-config/
└── scripts/
    └── fund-ledger.ts      # Utility: fund / top-up the 0G Compute ledger
```

Built with [Turborepo](https://turbo.build/) and [pnpm workspaces](https://pnpm.io/workspaces).

---

## Prerequisites

| Tool               | Version                           |
| ------------------ | --------------------------------- |
| Node.js            | ≥ 18                              |
| pnpm               | ≥ 9                               |
| A funded 0G wallet | See [0G docs](https://docs.0g.ai) |

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

| Variable               | Required | Description                                                                 |
| ---------------------- | -------- | --------------------------------------------------------------------------- |
| `ZG_PRIVATE_KEY`       | **yes**  | Private key of a funded 0G wallet (64-char hex, no `0x`)                   |
| `ZG_CHAIN_RPC`         | no       | 0G EVM RPC (default: `https://evmrpc-testnet.0g.ai`)                        |
| `ETH_RPC_URL`          | no       | Ethereum mainnet RPC (default: `https://eth.llamarpc.com`)                  |
| `ZG_COMPUTE_RPC`       | no       | 0G Compute indexer RPC (default: `https://indexer-storage-testnet-turbo.0g.ai`) |
| `ZG_STORAGE_RPC`       | no       | 0G Storage RPC (default: `https://evmrpc-testnet.0g.ai`)                    |
| `ZG_INDEXER_RPC`       | no       | 0G Storage indexer RPC (default: `https://indexer-storage-testnet-turbo.0g.ai`) |
| `ZG_FLOW_CONTRACT`     | no       | 0G Flow contract address (default: `0xbD2C3F0E65eDF5582141C35969d66e205E00C9c8`) |
| `UNISWAP_API_KEY`      | no       | Uniswap Trading API key (https://developers.uniswap.org/dashboard)          |
| `COINGECKO_API_KEY`    | no       | CoinGecko API key — free demo key or pro key (https://www.coingecko.com/en/api) |
| `MAX_SLIPPAGE_PCT`     | no       | Maximum swap slippage % (default: `1.5`)                                    |
| `MAX_POSITION_USDC`    | no       | Maximum position size in USDC (default: `50`)                               |
| `MIN_LIQUIDITY_USD`    | no       | Minimum pool liquidity required (default: `100000`)                         |
| `MAX_GAS_GWEI`         | no       | Gas price ceiling in Gwei (default: `30`)                                   |
| `RISK_SCORE_THRESHOLD` | no       | Minimum risk score to proceed (0–100, default: `70`)                        |
| `DRY_RUN`              | no       | `true` to simulate swaps without submitting on-chain (default: `true`)      |
| `CYCLE_INTERVAL_MS`    | no       | Milliseconds between autonomous cycles (default: `300000` = 5 min)          |
| `PORT`                 | no       | REST server port (default: `4000`)                                          |

### 3. Fund the 0G Compute ledger

Before first use, top up your 0G Compute ledger (target: 5 OG, keeps 1 OG reserve in wallet):

```sh
pnpm tsx scripts/fund-ledger.ts
```

### 4. Build

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

| Method | Path            | Description                                       |
| ------ | --------------- | ------------------------------------------------- |
| `GET`  | `/health`       | Liveness check (`{ status, running }`)            |
| `POST` | `/cycle`        | Run one full agent cycle (blocking JSON response) |
| `POST` | `/cycle/stream` | Run one full agent cycle with SSE event streaming |

#### Per-agent endpoints

Each agent can also be invoked individually. All support both a blocking JSON form and a Server-Sent Events stream form.

| Method | Path                                  | Body                     | Description                                   |
| ------ | ------------------------------------- | ------------------------ | --------------------------------------------- |
| `POST` | `/agents/researcher`                  | `{ goal?: string }`      | Run Researcher agent (JSON)                   |
| `POST` | `/agents/researcher/stream`           | `{ goal?: string }`      | Run Researcher agent (SSE)                    |
| `POST` | `/agents/researcher/prices`           | `{ tokens: string[] }`   | Fetch live prices for a list of token symbols |
| `POST` | `/agents/researcher/prices/stream`    | `{ tokens: string[] }`   | Same, as SSE                                  |
| `POST` | `/agents/researcher/market`           | `{ tokens: string[] }`   | Fetch CoinGecko 24h market data               |
| `POST` | `/agents/planner`                     | `{ goal?: string }`      | Run Planner agent (JSON)                      |
| `POST` | `/agents/planner/stream`              | `{ goal?: string }`      | Run Planner agent (SSE)                       |
| `POST` | `/agents/risk`                        | —                        | Run Risk agent (reads memory)                 |
| `POST` | `/agents/risk/stream`                 | —                        | Run Risk agent (SSE)                          |
| `POST` | `/agents/strategy`                    | —                        | Run Strategy agent (reads memory)             |
| `POST` | `/agents/strategy/stream`             | —                        | Run Strategy agent (SSE)                      |
| `POST` | `/agents/critic`                      | —                        | Run Critic agent (reads memory)               |
| `POST` | `/agents/critic/stream`               | —                        | Run Critic agent (SSE)                        |
| `POST` | `/agents/executor`                    | —                        | Run Executor agent (reads memory)             |
| `POST` | `/agents/executor/stream`             | —                        | Run Executor agent (SSE)                      |

#### State endpoints

| Method | Path       | Description                          |
| ------ | ---------- | ------------------------------------ |
| `GET`  | `/memory`  | Dump current blackboard memory       |
| `GET`  | `/history` | All cycle states from this session   |
| `GET`  | `/latest`  | Most recent completed cycle state    |

### Single cycle (CLI)

```sh
pnpm --filter orchestrator dev
```

---

## How a Cycle Works

Every agent writes its output to the shared `BlackboardMemory`. Each write is simultaneously uploaded to **0G Storage** as an immutable root hash, forming an on-chain audit trail. Every downstream agent reads prior outputs from that same memory via `memory.contextFor()`.

1. **Researcher** fetches live multi-protocol Uniswap pool data (V2/V3/V4/UniswapX) via the Uniswap Trading API, scrapes the Fear & Greed index and Reddit/news headlines via a TLS-spoofed browser client (`impit`), pulls CoinGecko 24h market data, detects the current market narrative (`ai | safe_haven | defi | l2 | staking | neutral`), and writes `researcher/report` to shared memory.
2. **Planner** reads `researcher/report` from memory and produces a `TradePlan` (strategy type, conservative constraints, per-agent task list), writing `planner/plan`.
3. **Risk Agent** reads `planner/plan` + `researcher/report` and runs each candidate through honeypot detection, ownership concentration checks, MEV exposure scoring, and more — writing `risk/assessments`.
4. **Strategy Agent** reads all prior memory, picks the highest-scoring safe candidate, and crafts an exact swap calldata spec (`TradeStrategy`), writing `strategy/proposal`.
5. **Critic Agent** reads all memory entries, performs a holistic review, and either approves or rejects with a confidence score + issues list — writing `critic/critique`.
6. **Executor** — if the Critic approved — calls Uniswap's `SwapRouter02` via `exactInputSingle`. A **`SIMULATION_ONLY` hard guard** in the code defaults to simulation regardless of `DRY_RUN`. Set it to `false` and `DRY_RUN=false` only when the wallet is funded and live trading is intended.

---

## Blackboard Memory Keys

| Key                  | Written by  | Content                        |
| -------------------- | ----------- | ------------------------------ |
| `researcher/report`  | Researcher  | `ResearchReport` (candidates)  |
| `planner/plan`       | Planner     | `TradePlan`                    |
| `risk/assessments`   | Risk        | `RiskAssessment[]`             |
| `strategy/proposal`  | Strategy    | `TradeStrategy`                |
| `critic/critique`    | Critic      | `Critique`                     |
| `executor/result`    | Executor    | `ExecutionResult`              |

---

## Development

```sh
# Type-check all packages
pnpm check-types

# Lint
pnpm lint

# Build with watch (individual package)
pnpm --filter @swarm/compute dev
```

---

## Key Dependencies

- [`@0glabs/0g-serving-broker`](https://www.npmjs.com/package/@0glabs/0g-serving-broker) — 0G Compute paymaster & inference client
- [`@0gfoundation/0g-ts-sdk`](https://www.npmjs.com/package/@0gfoundation/0g-ts-sdk) — 0G Storage SDK (file upload / root hash)
- [`ethers`](https://www.npmjs.com/package/ethers) v6 — Ethereum wallet & provider
- [`impit`](https://www.npmjs.com/package/impit) — TLS-fingerprint spoofer for bot-detection bypass (Fear & Greed, Reddit)
- [`zod`](https://www.npmjs.com/package/zod) — Runtime config & env validation
- [`express`](https://www.npmjs.com/package/express) — REST API server
- [`uuid`](https://www.npmjs.com/package/uuid) — Cycle ID generation

---

## License

MIT
