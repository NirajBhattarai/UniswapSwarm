import type { TokenDef } from "../core";

// Stablecoins: must be within +/-2% of $1. Others: reject <=0 or absurd values.
export function isPriceValid(price: number, token: TokenDef): boolean {
  if (!isFinite(price) || price <= 0) return false;
  if (token.isStablecoin) {
    return Math.abs(price - 1.0) <= 0.02;
  }
  return price >= 1e-6 && price <= 10_000_000;
}
