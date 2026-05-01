import type { WalletHolding } from "@swarm/shared";

import type { CoinGeckoMarketData } from "../core";
import { toChecksumSafe } from "./address";

const MIN_ETH_BALANCE = 0.0001;
const MIN_TOKEN_BALANCE = 0.000001;
const MIN_HOLDING_VALUE_USD = 0.01;

export function resolveEthUsdPrice(
  marketData: Map<string, CoinGeckoMarketData>,
): number {
  return (
    marketData.get("WETH")?.price_usd ?? marketData.get("ETH")?.price_usd ?? 0
  );
}

export function buildHolding(params: {
  symbol: string;
  address: string;
  decimals: number;
  balanceFormatted: number;
  marketData: Map<string, CoinGeckoMarketData>;
}): WalletHolding | null {
  const priceUSD = params.marketData.get(params.symbol)?.price_usd ?? 0;
  const valueUSD = params.balanceFormatted * priceUSD;
  return {
    symbol: params.symbol,
    address: toChecksumSafe(params.address),
    decimals: params.decimals,
    balanceFormatted: params.balanceFormatted,
    priceUSD,
    valueUSD,
  };
}

export function shouldKeepNativeEth(balanceFormatted: number): boolean {
  return balanceFormatted > MIN_ETH_BALANCE;
}

export function shouldKeepTokenBalance(balanceFormatted: number): boolean {
  return balanceFormatted > MIN_TOKEN_BALANCE;
}

export function applyDustFilterAndSort(
  holdings: WalletHolding[],
): WalletHolding[] {
  return holdings
    .filter((holding) => holding.valueUSD > MIN_HOLDING_VALUE_USD)
    .sort((a, b) => b.valueUSD - a.valueUSD);
}
