import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";

const ETH_RPC_URL = process.env.ETH_RPC_URL ?? "https://eth.llamarpc.com";

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
] as const;

const TOKENS = [
  { symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
  { symbol: "USDT", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7" },
  { symbol: "WETH", address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" },
  { symbol: "DAI", address: "0x6B175474E89094C44Da98b954EedeAC495271d0F" },
  { symbol: "WBTC", address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599" },
  { symbol: "UNI", address: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984" },
  { symbol: "LINK", address: "0x514910771AF9Ca656af840dff83E8264EcF986CA" },
] as const;

type BalanceItem = {
  symbol: string;
  address: string;
  decimals: number;
  balance: string;
  rawBalance: string;
};

export async function GET(req: NextRequest) {
  try {
    const address = req.nextUrl.searchParams.get("address") ?? "";
    if (!address || !ethers.isAddress(address)) {
      return NextResponse.json(
        { error: "Valid address query param is required" },
        { status: 400 },
      );
    }

    const provider = new ethers.JsonRpcProvider(ETH_RPC_URL);
    const balances: BalanceItem[] = [];

    const ethBal = await provider.getBalance(address);
    balances.push({
      symbol: "ETH",
      address: "native",
      decimals: 18,
      balance: ethers.formatUnits(ethBal, 18),
      rawBalance: ethBal.toString(),
    });

    for (const token of TOKENS) {
      try {
        const contract = new ethers.Contract(
          token.address,
          ERC20_ABI,
          provider,
        );
        const [rawBal, decimals] = (await Promise.all([
          contract.balanceOf(address),
          contract.decimals(),
        ])) as [bigint, number];

        balances.push({
          symbol: token.symbol,
          address: token.address,
          decimals,
          balance: ethers.formatUnits(rawBal, decimals),
          rawBalance: rawBal.toString(),
        });
      } catch {
        // Skip token if contract read fails on provider.
      }
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
