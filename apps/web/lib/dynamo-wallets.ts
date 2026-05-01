/**
 * DynamoDB store for per-user managed wallets.
 *
 * Table layout (single-table, PK-only — no GSI needed):
 *   PK  = connectedAddress (lowercase, "0x…")
 *   attrs: managedAddress, encryptedKey, iv, authTag, createdAt
 *
 * Environment variables required (server-side only):
 *   DYNAMODB_REGION, DYNAMODB_WALLETS_TABLE,
 *   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY  (or instance-role)
 *   WALLET_ENCRYPTION_KEY  (see wallet-encryption.ts)
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import { Wallet } from "ethers";
import { encrypt, decrypt } from "./wallet-encryption";
import type { EncryptedPayload } from "./wallet-encryption";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ManagedWalletRecord = {
  /** Reown/MetaMask address that owns this managed wallet (PK, lowercase) */
  connectedAddress: string;
  /** Server-generated wallet address used for 0G chain ops */
  managedAddress: string;
  /** AES-256-GCM encrypted private key */
  encryptedKey: string;
  iv: string;
  authTag: string;
  createdAt: number;
};

// ─── Singleton client ─────────────────────────────────────────────────────────

let _client: DynamoDBDocumentClient | null = null;

function getClient(): DynamoDBDocumentClient {
  if (_client) return _client;

  const region = process.env.DYNAMODB_REGION?.trim();
  if (!region) throw new Error("DYNAMODB_REGION is not set");

  const accessKeyId = process.env.AWS_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY?.trim();
  const sessionToken = process.env.AWS_SESSION_TOKEN?.trim() || undefined;

  const raw = new DynamoDBClient(
    accessKeyId && secretAccessKey
      ? {
          region,
          credentials: {
            accessKeyId,
            secretAccessKey,
            ...(sessionToken ? { sessionToken } : {}),
          },
        }
      : { region }, // fall through to instance-role / env-chain
  );
  _client = DynamoDBDocumentClient.from(raw, {
    marshallOptions: { removeUndefinedValues: true },
  });
  return _client;
}

function getTable(): string {
  const table = process.env.DYNAMODB_WALLETS_TABLE?.trim();
  if (!table) throw new Error("DYNAMODB_WALLETS_TABLE is not set");
  return table;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Look up the managed wallet for a connected address.
 * Returns null if no record exists yet.
 */
export async function getManagedWallet(
  connectedAddress: string,
): Promise<ManagedWalletRecord | null> {
  const pk = connectedAddress.toLowerCase();
  const result = await getClient().send(
    new GetCommand({
      TableName: getTable(),
      Key: { connectedAddress: pk },
    }),
  );
  if (!result.Item) return null;
  return result.Item as ManagedWalletRecord;
}

/**
 * Generate a new managed wallet, encrypt the private key, persist to DynamoDB.
 * Callers should call `getManagedWallet` first and only call this if null.
 */
export async function createManagedWallet(
  connectedAddress: string,
): Promise<ManagedWalletRecord> {
  const pk = connectedAddress.toLowerCase();
  const wallet = Wallet.createRandom();
  const { iv, authTag, ciphertext } = encrypt(wallet.privateKey);

  const record: ManagedWalletRecord = {
    connectedAddress: pk,
    managedAddress: wallet.address.toLowerCase(),
    encryptedKey: ciphertext,
    iv,
    authTag,
    createdAt: Date.now(),
  };

  await getClient().send(
    new PutCommand({
      TableName: getTable(),
      // Conditional write: only create if the item does not already exist,
      // guarding against rare race conditions at wallet creation.
      ConditionExpression: "attribute_not_exists(connectedAddress)",
      Item: record,
    }),
  );

  return record;
}

/**
 * Decrypt and return the raw private key for a managed wallet record.
 * FOR SERVER-SIDE INTERNAL USE ONLY — never expose in API responses.
 */
export function decryptManagedKey(record: ManagedWalletRecord): string {
  const payload: EncryptedPayload = {
    iv: record.iv,
    authTag: record.authTag,
    ciphertext: record.encryptedKey,
  };
  return decrypt(payload);
}

/**
 * Get-or-create: returns the existing record or creates a new one.
 * Handles the conditional-write race by retrying a GET on ConditionalCheckFailedException.
 */
export async function getOrCreateManagedWallet(
  connectedAddress: string,
): Promise<ManagedWalletRecord> {
  const existing = await getManagedWallet(connectedAddress);
  if (existing) return existing;

  try {
    return await createManagedWallet(connectedAddress);
  } catch (err: unknown) {
    const name =
      typeof err === "object" && err !== null && "name" in err
        ? (err as { name: string }).name
        : "";
    // Another concurrent request won the race — re-read the item it created
    if (name === "ConditionalCheckFailedException") {
      const created = await getManagedWallet(connectedAddress);
      if (created) return created;
    }
    throw err;
  }
}
