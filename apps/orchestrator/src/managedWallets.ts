/**
 * Managed wallet lookup for the orchestrator.
 *
 * Read-only: the orchestrator only needs to look up and decrypt keys.
 * Wallet creation happens in the web app's /api/wallet/managed route.
 *
 * Required env vars (same as web app):
 *   DYNAMODB_REGION, DYNAMODB_WALLETS_TABLE,
 *   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY,
 *   WALLET_ENCRYPTION_KEY
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { createDecipheriv } from "node:crypto";
import { logger } from "@swarm/shared";

// ─── AES-256-GCM helpers (mirrors apps/web/lib/wallet-encryption.ts) ─────────

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;

function getEncryptionKey(): Buffer {
  const hex = process.env.WALLET_ENCRYPTION_KEY ?? "";
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      "WALLET_ENCRYPTION_KEY must be a 64-char hex string. " +
        "Generate: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
    );
  }
  return Buffer.from(hex, "hex");
}

function decryptKey(payload: {
  iv: string;
  authTag: string;
  encryptedKey: string;
}): string {
  const key = getEncryptionKey();
  const iv = Buffer.from(payload.iv, "hex");
  const authTag = Buffer.from(payload.authTag, "hex");
  const ciphertext = Buffer.from(payload.encryptedKey, "hex");

  if (iv.length !== IV_BYTES) throw new Error("Invalid IV length");
  if (authTag.length !== TAG_BYTES) throw new Error("Invalid auth tag length");

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

// ─── DynamoDB client ──────────────────────────────────────────────────────────

let _client: DynamoDBDocumentClient | null = null;

function getClient(): DynamoDBDocumentClient | null {
  const region = process.env.DYNAMODB_REGION?.trim();
  const table = process.env.DYNAMODB_WALLETS_TABLE?.trim();
  if (!region || !table) return null; // wallets table not configured — skip silently

  if (_client) return _client;

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
      : { region },
  );
  _client = DynamoDBDocumentClient.from(raw, {
    marshallOptions: { removeUndefinedValues: true },
  });
  return _client;
}

function getTable(): string {
  return process.env.DYNAMODB_WALLETS_TABLE?.trim() ?? "";
}

// ─── Cached managed keys ──────────────────────────────────────────────────────
// Memory-cache decrypted keys per wallet address (safe: private keys are
// already in process memory once the orchestrator is running; caching avoids
// redundant DynamoDB + AES calls on every agent invocation).

const _keyCache = new Map<string, string>(); // connectedAddress → privateKey

/**
 * Look up the decrypted private key for the managed wallet linked to the
 * given connected address. Returns null if:
 *   - DynamoDB is not configured
 *   - No record exists (user hasn't connected yet)
 *   - WALLET_ENCRYPTION_KEY is not set
 */
export async function getManagedPrivateKey(
  connectedAddress: string,
): Promise<string | null> {
  const pk = connectedAddress.toLowerCase();

  if (_keyCache.has(pk)) return _keyCache.get(pk)!;

  const client = getClient();
  if (!client) return null;

  try {
    const result = await client.send(
      new GetCommand({
        TableName: getTable(),
        Key: { connectedAddress: pk },
      }),
    );
    if (!result.Item) return null;

    const record = result.Item as {
      encryptedKey: string;
      iv: string;
      authTag: string;
    };
    const privateKey = decryptKey(record);
    _keyCache.set(pk, privateKey);
    return privateKey;
  } catch (err) {
    logger.warn(
      `[ManagedWallet] Failed to load managed key for ${pk}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

/**
 * Check if a managed wallet address has ≥10 A0GI deposited.
 * Returns true when funded, false otherwise (or on network error).
 */
export async function isManagedWalletFunded(
  managedAddress: string,
): Promise<boolean> {
  const rpc = process.env.ZG_CHAIN_RPC ?? "https://evmrpc-testnet.0g.ai";
  const MIN = BigInt(10) * BigInt(10) ** BigInt(18);
  try {
    const res = await fetch(rpc, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getBalance",
        params: [managedAddress, "latest"],
      }),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { result?: string };
    return BigInt(data.result ?? "0x0") >= MIN;
  } catch {
    return false;
  }
}
