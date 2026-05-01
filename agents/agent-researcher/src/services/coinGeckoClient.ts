import { getConfig } from "@swarm/shared";

export function buildCoinGeckoRequest() {
  const { COINGECKO_API_KEY } = getConfig();
  const headers: Record<string, string> = { Accept: "application/json" };
  if (COINGECKO_API_KEY) {
    headers["x-cg-demo-api-key"] = COINGECKO_API_KEY;
  }
  const authQuery = COINGECKO_API_KEY
    ? `x_cg_demo_api_key=${encodeURIComponent(COINGECKO_API_KEY)}`
    : "";
  return { headers, authQuery, hasApiKey: Boolean(COINGECKO_API_KEY) };
}
