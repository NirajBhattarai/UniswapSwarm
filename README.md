# UniswapSwarm

An autonomous AI agent swarm that identifies and executes profitable, low-risk token swaps on **Uniswap V3** (Ethereum mainnet). Built on top of the **0G Compute Network** for verifiable, decentralised LLM inference.

> **Capital preservation first.** The swarm is tuned to prioritise safety over yield — every trade is planned, researched, risk-scored, strategised, and critiqued before execution.

---

## Architecture

The swarm runs a sequential pipeline of specialised agents that share a common **Blackboard Memory** per cycle:

```
Planner → Researcher → Risk → Strategy → Critic → Executor
```

| Agent          | Package            | Role                                                                                 |
| -------------- | ------------------ | ------------------------------------------------------------------------------------ |
| **Planner**    | `agent-planner`    | Breaks the high-level goal into a structured `TradePlan` with tasks and constraints  |
| **Researcher** | `agent-researcher` | Scans Uniswap V3 pools and returns ranked `TokenCandidate` objects                   |
| **Risk**       | `agent-risk`       | Scores each candidate (honeypot, low liquidity, MEV risk, …) and flags unsafe tokens |
| **Strategy**   | `agent-strategy`   | Selects the best trade route, sizes the position, and sets slippage/fee parameters   |
| **Critic**     | `agent-critic`     | Reviews the fully assembled plan and approves or rejects it with a confidence score  |
| **Executor**   | `agent-executor`   | Submits the swap via Uniswap V3's `SwapRouter` (supports dry-run mode)               |

All LLM calls go through `@swarm/compute` — a thin wrapper around the [0G Serving Broker](https://github.com/0glabs/0g-serving-broker) that auto-manages ledger deposits and provider acknowledgement.

---

## Monorepo Structure

```
uniswapswarm/
├── apps/
│   └── orchestrator/       # Express REST server + cycle runner
├── agents/
│   ├── agent-planner/
│   ├── agent-researcher/
│   ├── agent-risk/
│   ├── agent-strategy/
│   ├── agent-critic/
│   └── agent-executor/
└── packages/
    ├── compute/            # 0G Compute Network client (ZGCompute)
    ├── memory/             # BlackboardMemory — shared agent state per cycle
    ├── shared/             # Config, types, logger, constants
    ├── eslint-config/
    └── typescript-config/
```

Built with [Turborepo](https://turbo.build/) and [pnpm workspaces](https://pnpm.io/workspaces).

---

## Prerequisites

| Tool               | Version                           |
| ------------------ | --------------------------------- |
| Node.js            | ≥ 20                              |
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

| Variable               | Description                                              |
| ---------------------- | -------------------------------------------------------- |
| `ZG_PRIVATE_KEY`       | Private key of a funded 0G wallet (64-char hex, no `0x`) |
| `ZG_CHAIN_RPC`         | 0G EVM RPC (default: `https://evmrpc-testnet.0g.ai`)     |
| `ETH_RPC_URL`          | Ethereum mainnet RPC (Alchemy / Infura)                  |
| `ZG_COMPUTE_RPC`       | 0G Compute indexer RPC                                   |
| `MAX_SLIPPAGE_PCT`     | Maximum swap slippage % (default: `1.5`)                 |
| `MAX_POSITION_USDC`    | Maximum position size in USDC (default: `50`)            |
| `MIN_LIQUIDITY_USD`    | Minimum pool liquidity required (default: `100000`)      |
| `MAX_GAS_GWEI`         | Gas price ceiling in Gwei (default: `30`)                |
| `RISK_SCORE_THRESHOLD` | Minimum risk score to proceed (0–100, default: `70`)     |
| `DRY_RUN`              | Set `true` to simulate swaps without submitting on-chain |

### 3. Build

```sh
pnpm build
```

---

## Running

### REST server (recommended)

```sh
pnpm --filter orchestrator start
```

The server starts on port `3000` by default.

#### Endpoints

| Method | Path            | Description                                       |
| ------ | --------------- | ------------------------------------------------- |
| `GET`  | `/health`       | Liveness check                                    |
| `POST` | `/cycle`        | Run one full agent cycle (blocking JSON response) |
| `POST` | `/cycle/stream` | Run one full agent cycle with SSE event streaming |

### Single cycle (CLI)

```sh
pnpm --filter orchestrator dev
```

---

## How a Cycle Works

1. **Planner** receives the static goal and produces a `TradePlan` (strategy type, constraints, task list).
2. **Researcher** fetches live Uniswap V3 pool data and scores token candidates by volume, liquidity, and price momentum.
3. **Risk Agent** runs each candidate through a suite of checks (honeypot detection, ownership concentration, MEV exposure, …) and produces a `RiskAssessment`.
4. **Strategy Agent** picks the highest-scoring safe candidate and crafts an exact swap calldata spec (`TradeStrategy`).
5. **Critic Agent** performs a final holistic review and either approves or rejects the plan.
6. **Executor** — if approved — calls Uniswap V3's `SwapRouter`. In `DRY_RUN=true` mode it logs the would-be transaction without sending it.

All intermediate outputs are written to the shared `BlackboardMemory` so every downstream agent can read what came before it.

---

## Development

```sh
# Type-check all packages
pnpm typecheck

# Lint
pnpm lint

# Build with watch (individual package)
pnpm --filter @swarm/compute dev
```

---

## Key Dependencies

- [`@0glabs/0g-serving-broker`](https://www.npmjs.com/package/@0glabs/0g-serving-broker) — 0G Compute paymaster & inference client
- [`@uniswap/v3-sdk`](https://www.npmjs.com/package/@uniswap/v3-sdk) — Uniswap V3 quote & routing
- [`ethers`](https://www.npmjs.com/package/ethers) v6 — Ethereum wallet & provider
- [`zod`](https://www.npmjs.com/package/zod) — Runtime config validation
- [`express`](https://www.npmjs.com/package/express) — REST API server

---

## License

MIT
pnpm dlx turbo build
pnpm exec turbo build

````

You can build a specific package by using a [filter](https://turborepo.dev/docs/crafting-your-repository/running-tasks#using-filters):

With [global `turbo`](https://turborepo.dev/docs/getting-started/installation#global-installation) installed:

```sh
turbo build --filter=docs
````

Without global `turbo`:

```sh
npx turbo build --filter=docs
pnpm exec turbo build --filter=docs
pnpm exec turbo build --filter=docs
```

### Develop

To develop all apps and packages, run the following command:

With [global `turbo`](https://turborepo.dev/docs/getting-started/installation#global-installation) installed (recommended):

```sh
cd my-turborepo
turbo dev
```

Without global `turbo`, use your package manager:

```sh
cd my-turborepo
npx turbo dev
pnpm exec turbo dev
pnpm exec turbo dev
```

You can develop a specific package by using a [filter](https://turborepo.dev/docs/crafting-your-repository/running-tasks#using-filters):

With [global `turbo`](https://turborepo.dev/docs/getting-started/installation#global-installation) installed:

```sh
turbo dev --filter=web
```

Without global `turbo`:

```sh
npx turbo dev --filter=web
pnpm exec turbo dev --filter=web
pnpm exec turbo dev --filter=web
```

### Remote Caching

> [!TIP]
> Vercel Remote Cache is free for all plans. Get started today at [vercel.com](https://vercel.com/signup?utm_source=remote-cache-sdk&utm_campaign=free_remote_cache).

Turborepo can use a technique known as [Remote Caching](https://turborepo.dev/docs/core-concepts/remote-caching) to share cache artifacts across machines, enabling you to share build caches with your team and CI/CD pipelines.

By default, Turborepo will cache locally. To enable Remote Caching you will need an account with Vercel. If you don't have an account you can [create one](https://vercel.com/signup?utm_source=turborepo-examples), then enter the following commands:

With [global `turbo`](https://turborepo.dev/docs/getting-started/installation#global-installation) installed (recommended):

```sh
cd my-turborepo
turbo login
```

Without global `turbo`, use your package manager:

```sh
cd my-turborepo
npx turbo login
pnpm exec turbo login
pnpm exec turbo login
```

This will authenticate the Turborepo CLI with your [Vercel account](https://vercel.com/docs/concepts/personal-accounts/overview).

Next, you can link your Turborepo to your Remote Cache by running the following command from the root of your Turborepo:

With [global `turbo`](https://turborepo.dev/docs/getting-started/installation#global-installation) installed:

```sh
turbo link
```

Without global `turbo`:

```sh
npx turbo link
pnpm exec turbo link
pnpm exec turbo link
```

## Useful Links

Learn more about the power of Turborepo:

- [Tasks](https://turborepo.dev/docs/crafting-your-repository/running-tasks)
- [Caching](https://turborepo.dev/docs/crafting-your-repository/caching)
- [Remote Caching](https://turborepo.dev/docs/core-concepts/remote-caching)
- [Filtering](https://turborepo.dev/docs/crafting-your-repository/running-tasks#using-filters)
- [Configuration Options](https://turborepo.dev/docs/reference/configuration)
- [CLI Usage](https://turborepo.dev/docs/reference/command-line-reference)
