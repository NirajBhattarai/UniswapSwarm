#!/usr/bin/env tsx
/**
 * create-dynamo-tables.ts
 * Creates the two DynamoDB tables needed by UniswapSwarm:
 *   1. History table  (DYNAMODB_HISTORY_TABLE)  — session/cycle records
 *   2. Wallets table  (DYNAMODB_WALLETS_TABLE)   — per-user managed wallets
 *
 * Usage:
 *   pnpm tsx scripts/create-dynamo-tables.ts
 *
 * Required env vars (root .env):
 *   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, DYNAMODB_REGION
 *   DYNAMODB_HISTORY_TABLE, DYNAMODB_WALLETS_TABLE
 */

import "dotenv/config";
import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  waitUntilTableExists,
} from "@aws-sdk/client-dynamodb";

// ─── Config ──────────────────────────────────────────────────────────────────

const region = process.env["DYNAMODB_REGION"];
const accessKeyId = process.env["AWS_ACCESS_KEY_ID"];
const secretAccessKey = process.env["AWS_SECRET_ACCESS_KEY"];
const sessionToken = process.env["AWS_SESSION_TOKEN"] || undefined;

const historyTable = process.env["DYNAMODB_HISTORY_TABLE"];
const walletsTable =
  process.env["DYNAMODB_WALLETS_TABLE"] ?? "uniswap-swarm-wallets";
const historyGsi = process.env["DYNAMODB_HISTORY_GSI_USER"] ?? "GSI1";

if (!region) throw new Error("DYNAMODB_REGION is not set in .env");
if (!accessKeyId) throw new Error("AWS_ACCESS_KEY_ID is not set in .env");
if (!secretAccessKey)
  throw new Error("AWS_SECRET_ACCESS_KEY is not set in .env");
if (!historyTable) throw new Error("DYNAMODB_HISTORY_TABLE is not set in .env");

// ─── Client ──────────────────────────────────────────────────────────────────

const client = new DynamoDBClient({
  region,
  credentials: {
    accessKeyId,
    secretAccessKey,
    ...(sessionToken ? { sessionToken } : {}),
  },
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function tableExists(tableName: string): Promise<boolean> {
  try {
    await client.send(new DescribeTableCommand({ TableName: tableName }));
    return true;
  } catch {
    return false;
  }
}

// ─── Table definitions ───────────────────────────────────────────────────────

async function ensureHistoryTable(): Promise<void> {
  const name = historyTable!;
  if (await tableExists(name)) {
    console.log(`✓ History table "${name}" already exists — skipping`);
    return;
  }
  console.log(`Creating history table "${name}" …`);
  try {
    await client.send(
      new CreateTableCommand({
        TableName: name,
        BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: [
          { AttributeName: "PK", AttributeType: "S" },
          { AttributeName: "SK", AttributeType: "S" },
          { AttributeName: "GSI1PK", AttributeType: "S" },
          { AttributeName: "GSI1SK", AttributeType: "S" },
        ],
        KeySchema: [
          { AttributeName: "PK", KeyType: "HASH" },
          { AttributeName: "SK", KeyType: "RANGE" },
        ],
        GlobalSecondaryIndexes: [
          {
            IndexName: historyGsi,
            KeySchema: [
              { AttributeName: "GSI1PK", KeyType: "HASH" },
              { AttributeName: "GSI1SK", KeyType: "RANGE" },
            ],
            Projection: { ProjectionType: "ALL" },
          },
        ],
      }),
    );
    console.log(`  Waiting for "${name}" to become ACTIVE …`);
    await waitUntilTableExists(
      { client, maxWaitTime: 60 },
      { TableName: name },
    );
    console.log(`✓ History table "${name}" created`);
  } catch (err: unknown) {
    const code = (err as { name?: string })?.name;
    if (code === "ResourceInUseException") {
      console.log(`✓ History table "${name}" already exists (race) — ok`);
    } else {
      throw err;
    }
  }
}

async function ensureWalletsTable(): Promise<void> {
  const name = walletsTable;
  if (await tableExists(name)) {
    console.log(`✓ Wallets table "${name}" already exists — skipping`);
    return;
  }
  console.log(`Creating wallets table "${name}" …`);
  try {
    await client.send(
      new CreateTableCommand({
        TableName: name,
        BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: [
          { AttributeName: "connectedAddress", AttributeType: "S" },
        ],
        KeySchema: [{ AttributeName: "connectedAddress", KeyType: "HASH" }],
      }),
    );
    console.log(`  Waiting for "${name}" to become ACTIVE …`);
    await waitUntilTableExists(
      { client, maxWaitTime: 60 },
      { TableName: name },
    );
    console.log(`✓ Wallets table "${name}" created`);
  } catch (err: unknown) {
    const code = (err as { name?: string })?.name;
    if (code === "ResourceInUseException") {
      console.log(`✓ Wallets table "${name}" already exists (race) — ok`);
    } else {
      throw err;
    }
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`\nAWS region : ${region}`);
  console.log(`History    : ${historyTable}`);
  console.log(`Wallets    : ${walletsTable}\n`);

  await ensureHistoryTable();
  await ensureWalletsTable();

  console.log("\nAll tables are ready.");
}

main().catch((err) => {
  console.error("\n✗ Error:", err?.message ?? err);
  process.exit(1);
});
