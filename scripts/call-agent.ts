#!/usr/bin/env tsx
/**
 * call-agent.ts
 *
 * Resolves an agent's A2A endpoint URL from its ENS name (text[url] record)
 * and sends a JSON-RPC message to it, printing the streamed response.
 *
 * Usage:
 *   npm run call-agent -- researcher "Find top ETH pools"
 *   npm run call-agent -- planner   "Plan a conservative ETH/USDC swap"
 *   npm run call-agent -- risk      "Assess risk for UNI and ARB"
 *
 * Required env vars:
 *   ENS_RPC_URL  — Sepolia RPC (to resolve ENS text[url])
 *
 * The orchestrator must be running locally (npm run dev) or be deployed.
 */

import "dotenv/config";
import { ethers } from "ethers";
import { AGENT_ENS_NAMES } from "@swarm/shared";
import { v4 as uuidv4 } from "uuid";

type AgentId = keyof typeof AGENT_ENS_NAMES;

const TEXT_RESOLVER_ABI = [
  "function text(bytes32 node, string key) view returns (string)",
  "function resolver(bytes32 node) view returns (address)",
] as const;

const REGISTRY_ABI = [
  "function resolver(bytes32 node) view returns (address)",
] as const;

async function resolveAgentUrl(agentId: AgentId): Promise<string> {
  const rpcUrl = process.env["ENS_RPC_URL"];
  if (!rpcUrl) throw new Error("ENS_RPC_URL is not set.");

  const ensName = AGENT_ENS_NAMES[agentId];
  const provider = new ethers.JsonRpcProvider(rpcUrl, 11155111, {
    staticNetwork: true,
  });

  // Use ethers built-in ENS resolver (works on Sepolia)
  const url = await provider.getResolver(ensName).then(async (r) => {
    if (!r) throw new Error(`No resolver found for ${ensName}`);
    return r.getText("url");
  });

  if (!url)
    throw new Error(
      `No text[url] record set for ${ensName}. Run: npm run setup-ens`,
    );
  return url;
}

async function main() {
  const args = process.argv.slice(2);
  const agentId = args[0] as AgentId | undefined;
  const message = args.slice(1).join(" ");

  if (!agentId || !message) {
    console.error(
      "Usage: npm run call-agent -- <agentId> <message>\n" +
        "  agentId: researcher | planner | risk | strategy | critic | executor\n" +
        '  example: npm run call-agent -- researcher "Find top ETH pools"',
    );
    process.exit(1);
  }

  if (!(agentId in AGENT_ENS_NAMES)) {
    console.error(
      `Unknown agent: "${agentId}". Valid: ${Object.keys(AGENT_ENS_NAMES).join(", ")}`,
    );
    process.exit(1);
  }

  const ensName = AGENT_ENS_NAMES[agentId];
  console.log(`Resolving URL from ENS: ${ensName} ...`);

  const agentUrl = await resolveAgentUrl(agentId);
  console.log(`Agent URL : ${agentUrl}`);
  console.log(`Message   : "${message}"\n`);

  const messageId = uuidv4();

  // A2A JSON-RPC 2.0 — message/send (non-streaming)
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "message/send",
    params: {
      message: {
        kind: "message",
        messageId,
        role: "user",
        parts: [{ kind: "text", text: message }],
      },
    },
  };

  const res = await fetch(agentUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`HTTP ${res.status}: ${text}`);
    process.exit(1);
  }

  const json = (await res.json()) as any;

  if (json.error) {
    console.error(`A2A error: ${json.error.message} (code ${json.error.code})`);
    process.exit(1);
  }

  // result is a Message: { kind: "message", parts: [{ kind: "text", text }] }
  const parts: any[] = json.result?.parts ?? [];

  process.stdout.write("Response:\n");
  for (const part of parts) {
    if ((part?.kind === "text" || part?.type === "text") && part.text) {
      // Pretty-print if text is JSON, otherwise print as-is
      try {
        const parsed = JSON.parse(part.text);
        process.stdout.write(JSON.stringify(parsed, null, 2));
      } catch {
        process.stdout.write(part.text);
      }
    }
  }
  process.stdout.write("\n");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
