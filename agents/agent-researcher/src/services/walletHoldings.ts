import type { WalletHolding } from "@swarm/shared";
import { ethers } from "ethers";

import { SYMBOL_TO_TOKEN } from "../core";
import type { CoinGeckoMarketData } from "../core";
import {
  applyDustFilterAndSort,
  buildHolding,
  normalizeAddress,
  normalizeSymbol,
  resolveEthUsdPrice,
  shouldKeepNativeEth,
  shouldKeepTokenBalance,
} from "../utils";

type TokenBalancesResult = {
  tokenBalances: Array<{
    contractAddress: string;
    tokenBalance: string | null;
  }>;
};

type TokenEntry = {
  contractAddress: string;
  tokenBalance: string;
  symbol: string;
  decimals: number;
};

const ZERO_BALANCE =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

export async function fetchWalletHoldingsAlchemy(params: {
  walletAddress: string;
  marketData: Map<string, CoinGeckoMarketData>;
  alchemyKey: string;
}): Promise<WalletHolding[]> {
  const { walletAddress, marketData, alchemyKey } = params;
  const rpcUrl = `https://eth-mainnet.g.alchemy.com/v2/${alchemyKey}`;
  const batchBody = [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getBalance",
      params: [walletAddress, "latest"],
    },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "alchemy_getTokenBalances",
      params: [walletAddress, "erc20"],
    },
  ];

  const batchResp = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(batchBody),
  });
  if (!batchResp.ok) {
    throw new Error(`Alchemy batch RPC failed: HTTP ${batchResp.status}`);
  }

  const batchData = (await batchResp.json()) as Array<{
    id: number;
    result?: unknown;
  }>;
  const ethHex = batchData.find((r) => r.id === 1)?.result as
    | string
    | undefined;
  const tokenBalancesResult = batchData.find((r) => r.id === 2)?.result as
    | TokenBalancesResult
    | undefined;

  const holdings: WalletHolding[] = [];
  if (ethHex) {
    const ethFormatted = parseFloat(ethers.formatEther(BigInt(ethHex)));
    const ethPrice = resolveEthUsdPrice(marketData);
    if (shouldKeepNativeEth(ethFormatted)) {
      holdings.push({
        symbol: "ETH",
        address: "ETH",
        decimals: 18,
        balanceFormatted: ethFormatted,
        priceUSD: ethPrice,
        valueUSD: ethFormatted * ethPrice,
      });
    }
  }

  const nonZero = (tokenBalancesResult?.tokenBalances ?? []).filter(
    (t) => t.tokenBalance && t.tokenBalance !== ZERO_BALANCE,
  );

  const addrToKnown = new Map<string, { symbol: string; decimals: number }>();
  for (const [sym, def] of Object.entries(SYMBOL_TO_TOKEN)) {
    addrToKnown.set(normalizeAddress(def.address), {
      symbol: normalizeSymbol(sym),
      decimals: def.decimals,
    });
  }

  const knownEntries: TokenEntry[] = [];
  const unknownAddresses: string[] = [];
  for (const token of nonZero) {
    const known = addrToKnown.get(normalizeAddress(token.contractAddress));
    if (known) {
      knownEntries.push({
        contractAddress: token.contractAddress,
        tokenBalance: token.tokenBalance!,
        symbol: known.symbol,
        decimals: known.decimals,
      });
      continue;
    }
    unknownAddresses.push(token.contractAddress);
  }

  const unknownEntries = await resolveUnknownTokenEntries(
    rpcUrl,
    unknownAddresses,
    nonZero,
  );
  for (const token of [...knownEntries, ...unknownEntries]) {
    const raw = BigInt(token.tokenBalance);
    const formatted = parseFloat(ethers.formatUnits(raw, token.decimals));
    if (!shouldKeepTokenBalance(formatted)) continue;
    const holding = buildHolding({
      symbol: token.symbol,
      address: token.contractAddress,
      decimals: token.decimals,
      balanceFormatted: formatted,
      marketData,
    });
    if (holding) holdings.push(holding);
  }

  return applyDustFilterAndSort(holdings);
}

async function resolveUnknownTokenEntries(
  rpcUrl: string,
  unknownAddresses: string[],
  nonZero: Array<{ contractAddress: string; tokenBalance: string | null }>,
): Promise<TokenEntry[]> {
  if (unknownAddresses.length === 0) return [];

  const metaBatch = unknownAddresses.map((addr, i) => ({
    jsonrpc: "2.0",
    id: i + 1,
    method: "alchemy_getTokenMetadata",
    params: [addr],
  }));
  const metaResp = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(metaBatch),
  });
  if (!metaResp.ok) return [];

  const metaData = (await metaResp.json()) as Array<{
    id: number;
    result?: { symbol?: string | null; decimals?: number | null };
  }>;
  const metaMap = new Map<string, { symbol: string; decimals: number }>();
  for (let i = 0; i < unknownAddresses.length; i++) {
    const meta = metaData.find((m) => m.id === i + 1)?.result;
    if (meta?.symbol && meta?.decimals != null) {
      metaMap.set(normalizeAddress(unknownAddresses[i]!), {
        symbol: normalizeSymbol(meta.symbol),
        decimals: meta.decimals,
      });
    }
  }

  return nonZero.flatMap((token) => {
    const meta = metaMap.get(normalizeAddress(token.contractAddress));
    return meta && token.tokenBalance
      ? [
          {
            contractAddress: token.contractAddress,
            tokenBalance: token.tokenBalance,
            symbol: meta.symbol,
            decimals: meta.decimals,
          },
        ]
      : [];
  });
}
