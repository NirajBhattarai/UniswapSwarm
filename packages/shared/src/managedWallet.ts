/**
 * Shared managed wallet utilities for DynamoDB access and key decryption.
 * Used by both the orchestrator and web app.
 *
 * Table layout:
 *   PK (Partition Key): connectedAddress (lowercase "0x…")
 *   Attributes:
 *     - managedAddress: Server-generated wallet for 0G operations
 *     - encryptedKey: AES-256-GCM encrypted private key (hex)
 *     - iv: Initialization vector (hex)
 *     - authTag: Authentication tag (hex)
 *     - createdAt: Timestamp
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { createDecipheriv } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;

function getEncryptionKey(): Buffer {
  const hex = process.env.WALLET_ENCRYPTION_KEY ?? "";
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      "WALLET_ENCRYPTION_KEY must be a 64-char hex string (check .env).",
    );
  }
  return Buffer.from(hex, "hex");
}

/**
 * Decrypt an encrypted private key using AES-256-GCM.
 * Expects: iv (hex), authTag (hex), encryptedKey (hex)
 */
function decryptKey(
  iv: string,
  authTag: string,
  encryptedKey: string,
): string {
  const key = getEncryptionKey();
  const ivBuf = Buffer.from(iv, "hex");
  const tagBuf = Buffer.from(authTag, "hex");
  const cipherBuf = Buffer.from(encryptedKey, "hex");

  if (ivBuf.length !== IV_BYTES) throw new Error("Invalid IV length");
  if (tagBuf.length !== TAG_BYTES) throw new Error("Invalid auth tag length");

  const decipher = createDecipheriv(ALGORITHM, key, ivBuf);
  decipher.setAuthTag(tagBuf);
  return Buffer.concat([
    decipher.update(cipherBuf),
    decipher.final(),
  ]).toString("utf8");
}

/**
 * Fetch a managed wallet's private key from DynamoDB.
 * Returns null if the wallet is not found or credentials are missing.
 */
export async function getManagedPrivateKey(
  connectedAddress: string,
): Promise<string | null> {
  const encryptionKey = process.env.WALLET_ENCRYPTION_KEY;
  const tableName = process.env.DYNAMODB_WALLETS_TABLE || "uniswap-swarm-wallets";
  const region = process.env.DYNAMODB_REGION || "us-east-1";
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;

  if (!encryptionKey || !accessKeyId || !secretAccessKey) {
    throw new Error(
      "Missing AWS credentials or encryption key: WALLET_ENCRYPTION_KEY, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY must be in .env",
    );
  }

  try {
    const client = new DynamoDBClient({
      region,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    });

    const docClient = DynamoDBDocumentClient.from(client, {
      marshallOptions: { removeUndefinedValues: true },
    });

    // Query using connectedAddress (partition key, lowercase)
    const pk = connectedAddress.toLowerCase();
    const result = await docClient.send(
      new GetCommand({
        TableName: tableName,
        Key: { connectedAddress: pk },
      }),
    );

    if (!result.Item) {
      return null;
    }

    const item = result.Item as Record<string, unknown>;
    const iv = String(item.iv ?? "");
    const authTag = String(item.authTag ?? "");
    const encryptedKey = String(item.encryptedKey ?? "");

    if (!iv || !authTag || !encryptedKey) {
      throw new Error(
        `Managed wallet ${connectedAddress} missing encryption fields`,
      );
    }

    return decryptKey(iv, authTag, encryptedKey);
  } catch (err) {
    throw new Error(
      `Failed to fetch managed wallet from DynamoDB: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Check if a managed wallet exists in DynamoDB.
 */
export async function hasManagedWallet(
  connectedAddress: string,
): Promise<boolean> {
  try {
    const key = await getManagedPrivateKey(connectedAddress);
    return key !== null;
  } catch {
    return false;
  }
}
