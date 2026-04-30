# UniswapSwarm Web Cockpit (`apps/web`)

This app is the operator cockpit for UniswapSwarm. It provides:

- CopilotKit chat with AG-UI/A2A routing to swarm agents
- visual per-agent handoffs and structured outputs
- wallet connect + signing UX for swap approval flows
- API routes for swap prepare/execute powered by the Uniswap Trade API

## Run locally

From the repository root:

```bash
pnpm dev
```

This starts both the orchestrator and the web app. Open `http://localhost:3000`.

If you only want the web app:

```bash
pnpm --filter web dev
```

## Required environment

The web app reads its environment from `apps/web/.env`.

Required or commonly needed values:

- `GOOGLE_GENERATIVE_AI_API_KEY` (required)
- `NEXT_PUBLIC_REOWN_PROJECT_ID` for wallet connect
- `UNISWAP_API_KEY` for `/api/swap/prepare` and `/api/swap/execute`
- `ALCHEMY_API_KEY` for `/api/wallet/portfolio` token balances
- `COPILOTKIT_MODEL` default: `gemini-2.5-flash`
- `NEXT_PUBLIC_ORCHESTRATOR_URL` default: `http://localhost:4000`
- `ORCHESTRATOR_URL` default: `http://localhost:4000`
- `NEXT_PUBLIC_COPILOTKIT_RUNTIME_URL` default: `/api/copilotkit`
- `ETH_RPC_URL` optional fallback RPC for native ETH balance reads

## Architecture pointers

- A2A agent descriptors: `lib/swarm-agents.ts`
- CopilotKit runtime routes: `app/api/copilotkit/`
- Swap helpers: `app/api/swap/prepare/route.ts`, `app/api/swap/execute/route.ts`
- Main UI shell: `components/swarm-chat.tsx`
