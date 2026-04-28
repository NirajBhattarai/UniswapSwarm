"use client";

import { createAppKit } from "@reown/appkit/react";
import { mainnet } from "@reown/appkit/networks";
import { EthersAdapter } from "@reown/appkit-adapter-ethers";

const projectId = process.env.NEXT_PUBLIC_REOWN_PROJECT_ID ?? "";

if (!projectId) {
  throw new Error(
    "Missing NEXT_PUBLIC_REOWN_PROJECT_ID. Add it to apps/web/.env.local or root .env.",
  );
}

const metadata = {
  name: "Uniswap Swarm",
  description: "User-signed Uniswap swaps from Reown wallet connection",
  url: "http://localhost:3000",
  icons: ["https://uniswap.org/favicon.ico"],
};

export const networks = [mainnet] as const;

let initialized = false;

export function ensureAppKitInit(): void {
  if (initialized) return;
  createAppKit({
    adapters: [new EthersAdapter()],
    projectId,
    networks: [...networks],
    metadata,
  });
  initialized = true;
}
