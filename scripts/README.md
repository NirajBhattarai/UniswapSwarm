# scripts/

One-off operational scripts for the UniswapSwarm monorepo. Run them with `pnpm run <script>` from the repo root.

---

## Scripts

### `train-model.ts` — Fine-tune a 0G AI model

Trains a `Qwen2.5-0.5B-Instruct` model on the **0G testnet** to classify crypto tokens by type, then verifies the result with inference.

**What it does, step by step:**

1. Generates a 136-example inline JSONL dataset covering 63 tokens across 5 categories
2. Connects to the 0G Compute Network (chain ID 16602)
3. Ensures the compute ledger exists and the fine-tuning sub-account is funded
4. Uploads the dataset to the provider's TEE (Trusted Execution Environment)
5. Submits a fine-tuning task via the 0G broker contract
6. Polls every 15 s until the task status becomes `Finished` (up to 4 h)
7. Downloads the resulting LoRA adapter
8. Runs 15 inference prompts to verify the trained model responds correctly

**Token categories:**

| Category | Tokens (examples)                   |
| -------- | ----------------------------------- |
| L1       | ETH, BTC, SOL, AVAX, BNB, ADA, ZG … |
| L2       | ARB, OP, MATIC, STRK, ZKS, SCROLL … |
| DeFi     | UNI, AAVE, CRV, GMX, DYDX, LDO …    |
| RWA      | ONDO, PAXG, XAUT, CFG, MPLX …       |
| AI       | FET, TAO, OCEAN, RNDR, AGIX, GRT …  |

**Usage:**

```bash
# Full pipeline (train + verify)
pnpm run train-model

# Override model or provider
pnpm run train-model -- --model Qwen2.5-0.5B-Instruct
pnpm run train-model -- --provider 0xA02b95…

# Skip training; resume verification for an existing task
pnpm run train-model -- --skip-train --task-id <uuid>

# Use 0G Storage instead of TEE for dataset upload
pnpm run train-model -- --upload-method 0g-storage
```

**Required `.env` variables:**

| Variable         | Description                                              |
| ---------------- | -------------------------------------------------------- |
| `ZG_PRIVATE_KEY` | 64-char hex private key for your testnet wallet          |
| `ZG_CHAIN_RPC`   | 0G EVM RPC URL (default: `https://evmrpc-testnet.0g.ai`) |

> **Testnet note:** Only `Qwen2.5-0.5B-Instruct` is supported on the 0G testnet. Using any other model name will cause a provider error.

---

### `fund-ledger.ts` — Top up the 0G compute ledger

Checks the current 0G Compute Network ledger balance and automatically tops it up to a **5 OG target**, keeping a **1 OG reserve** in the wallet.

**Decision logic:**

| Ledger balance | Action                                                                 |
| -------------- | ---------------------------------------------------------------------- |
| ≥ 5 OG         | Nothing — already funded                                               |
| 1 – 5 OG       | Deposit `(5 − balance)` OG                                             |
| < 1 OG / none  | Deposit as much as possible up to 5 OG, keeping 1 OG reserve in wallet |

**Usage:**

```bash
pnpm run fund-ledger
```

**Required `.env` variables:**

| Variable         | Description             |
| ---------------- | ----------------------- |
| `ZG_PRIVATE_KEY` | 64-char hex private key |
| `ZG_CHAIN_RPC`   | 0G EVM RPC URL          |

---

### `create-dynamo-tables.ts` — Provision DynamoDB tables

Creates the two DynamoDB tables required by the UniswapSwarm backend if they do not already exist. Safe to re-run — existing tables are left untouched.

**Tables created:**

| Table env var            | Purpose                         | Key schema                    |
| ------------------------ | ------------------------------- | ----------------------------- |
| `DYNAMODB_HISTORY_TABLE` | Stores session / cycle records  | PK (HASH) + SK (RANGE) + GSI1 |
| `DYNAMODB_WALLETS_TABLE` | Stores per-user managed wallets | `connectedAddress` (HASH)     |

**Usage:**

```bash
pnpm tsx scripts/create-dynamo-tables.ts
```

**Required `.env` variables:**

| Variable                 | Description                    |
| ------------------------ | ------------------------------ |
| `AWS_ACCESS_KEY_ID`      | AWS credentials                |
| `AWS_SECRET_ACCESS_KEY`  | AWS credentials                |
| `DYNAMODB_REGION`        | e.g. `us-east-1`               |
| `DYNAMODB_HISTORY_TABLE` | Table name for history records |
| `DYNAMODB_WALLETS_TABLE` | Table name for managed wallets |

---

## `tsconfig.json`

Extends `packages/typescript-config/node.json` with relaxed settings (`strict: false`, `skipLibCheck: true`) so the scripts compile without errors from third-party SDK types.
