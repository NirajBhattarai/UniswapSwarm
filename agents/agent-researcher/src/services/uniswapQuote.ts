import { UNISWAP_TRADE_API_BASE_URL } from "@swarm/shared";

import type { UniswapAPIQuoteResponse } from "../core/types";

interface RequestUniswapQuoteArgs {
  apiKey: string;
  body: Record<string, unknown>;
  universalRouterVersion?: string;
}

export async function requestUniswapQuote({
  apiKey,
  body,
  universalRouterVersion,
}: RequestUniswapQuoteArgs): Promise<Response> {
  const headers: Record<string, string> = {
    "x-api-key": apiKey,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (universalRouterVersion) {
    headers["x-universal-router-version"] = universalRouterVersion;
  }
  return fetch(`${UNISWAP_TRADE_API_BASE_URL}/quote`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

export async function parseUniswapQuoteResponse(
  response: Response,
): Promise<UniswapAPIQuoteResponse> {
  return (await response.json()) as UniswapAPIQuoteResponse;
}
