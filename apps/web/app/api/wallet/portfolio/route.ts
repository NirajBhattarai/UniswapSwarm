import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";

const ETH_RPC_URL = process.env.ETH_RPC_URL ?? "https://eth.llamarpc.com";
const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY ?? "";
const ALCHEMY_MAINNET_RPC = ALCHEMY_API_KEY
  ? `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`
  : "";

const ZERO_BALANCE_HEX =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

type BalanceItem = {
  symbol: string;
  address: string;
  decimals: number;
  balance: string;
  rawBalance: string;
};

type RpcBatchItem = {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: unknown[];
};

type RpcBatchResult = {
  id: number;
  result?: unknown;
  error?: { message?: string };
};

async function fetchAlchemyBalances(address: string): Promise<BalanceItem[]> {
  if (!ALCHEMY_MAINNET_RPC) {
    throw new Error("ALCHEMY_API_KEY is not configured");
  }

  const batch: RpcBatchItem[] = [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getBalance",
      params: [address, "latest"],
    },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "alchemy_getTokenBalances",
      params: [address, "erc20"],
    },
  ];

  const batchResp = await fetch(ALCHEMY_MAINNET_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(batch),
  });
  if (!batchResp.ok) {
    throw new Error(`Alchemy batch request failed: HTTP ${batchResp.status}`);
  }

  const batchData = (await batchResp.json()) as RpcBatchResult[];
  const ethHex = batchData.find((r) => r.id === 1)?.result as
    | string
    | undefined;
  const tokenResult = batchData.find((r) => r.id === 2)?.result as
    | {
        tokenBalances?: Array<{
          contractAddress: string;
          tokenBalance: string | null;
        }>;
      }
    | undefined;

  const balances: BalanceItem[] = [];
  if (ethHex) {
    const ethRaw = BigInt(ethHex);
    balances.push({
      symbol: "ETH",
      address: "native",
      decimals: 18,
      balance: ethers.formatEther(ethRaw),
      rawBalance: ethRaw.toString(),
    });
  }

  const nonZeroTokenBalances = (tokenResult?.tokenBalances ?? []).filter(
    (t) => t.tokenBalance && t.tokenBalance !== ZERO_BALANCE_HEX,
  );
  if (nonZeroTokenBalances.length === 0) {
    return balances;
  }

  const metadataBatch: RpcBatchItem[] = nonZeroTokenBalances.map((t, i) => ({
    jsonrpc: "2.0",
    id: i + 1000,
    method: "alchemy_getTokenMetadata",
    params: [t.contractAddress],
  }));
  const metadataResp = await fetch(ALCHEMY_MAINNET_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(metadataBatch),
  });
  if (!metadataResp.ok) {
    throw new Error(
      `Alchemy metadata request failed: HTTP ${metadataResp.status}`,
    );
  }
  const metadataData = (await metadataResp.json()) as RpcBatchResult[];
  const metadataById = new Map<
    number,
    { symbol?: string; decimals?: number }
  >();
  for (const item of metadataData) {
    if (typeof item.id !== "number") continue;
    const meta = item.result as
      | { symbol?: string; decimals?: number }
      | undefined;
    metadataById.set(item.id, meta ?? {});
  }

  nonZeroTokenBalances.forEach((token, idx) => {
    const meta = metadataById.get(idx + 1000);
    if (!meta?.symbol || meta.decimals == null) return;
    const rawBalance = token.tokenBalance;
    if (!rawBalance) return;
    const decimals = Number(meta.decimals);
    if (!Number.isFinite(decimals)) return;
    const raw = BigInt(rawBalance);
    balances.push({
      symbol: meta.symbol.toUpperCase(),
      address: token.contractAddress,
      decimals,
      balance: ethers.formatUnits(raw, decimals),
      rawBalance: raw.toString(),
    });
  });

  return balances;
}

export async function GET(req: NextRequest) {
  try {
    const address = req.nextUrl.searchParams.get("address") ?? "";
    if (!address || !ethers.isAddress(address)) {
      return NextResponse.json(
        { error: "Valid address query param is required" },
        { status: 400 },
      );
    }

    let balances: BalanceItem[];
    try {
      balances = await fetchAlchemyBalances(address);
    } catch {
      // Fallback: at least return native ETH from generic RPC if Alchemy is missing/down.
      const provider = new ethers.JsonRpcProvider(ETH_RPC_URL);
      const ethBal = await provider.getBalance(address);
      balances = [
        {
          symbol: "ETH",
          address: "native",
          decimals: 18,
          balance: ethers.formatUnits(ethBal, 18),
          rawBalance: ethBal.toString(),
        },
      ];
    }

    const nonZero = balances
      .filter((b) => {
        const n = Number(b.balance);
        return Number.isFinite(n) && n > 0;
      })
      .sort((a, b) => Number(b.balance) - Number(a.balance));

    return NextResponse.json({
      address,
      balances,
      nonZeroBalances: nonZero,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
