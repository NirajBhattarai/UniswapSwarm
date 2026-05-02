# scripts/

One-off operational scripts for the UniswapSwarm monorepo. Run them with `pnpm run <script>` from the repo root.

---

## Scripts

Legacy token-classifier training scripts were removed. Token routing now happens directly in the Research agent prompt flow based on user goal categories (for example: DeFi, L1, L2, AI, RWA).

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
