import { NextRequest, NextResponse } from "next/server";

const UNISWAP_TRADE_API_BASE_URL = "https://trade-api.gateway.uniswap.org/v1";

type TxRequestLike = {
  to: string;
  data: string;
  value?: string;
};

type ExecuteRequest = {
  /** Full response from POST /quote — spread into the /swap body per Trading API spec */
  quoteResponse: Record<string, unknown>;
  /** Wallet signature over permitData (eth_signTypedData_v4) */
  signature?: string | null;
};

function asTxRequest(value: unknown): TxRequestLike | null {
  if (typeof value !== "object" || value === null) return null;
  const rec = value as Record<string, unknown>;
  const to = rec["to"];
  const data = rec["data"];
  if (typeof to !== "string" || typeof data !== "string") return null;
  const rawValue = rec["value"];
  const valueStr =
    typeof rawValue === "string"
      ? rawValue
      : rawValue == null
        ? undefined
        : String(rawValue);
  return valueStr === undefined ? { to, data } : { to, data, value: valueStr };
}

function extractTxRequest(
  payload: Record<string, unknown>,
): TxRequestLike | null {
  const candidates: unknown[] = [
    payload,
    payload["txRequest"],
    payload["transaction"],
    payload["swap"],
  ];
  for (const candidate of candidates) {
    const tx = asTxRequest(candidate);
    if (tx) return tx;
  }
  for (const value of Object.values(payload)) {
    const tx = asTxRequest(value);
    if (tx) return tx;
  }
  return null;
}

async function callSwapApi(
  body: Record<string, unknown>,
  apiKey: string,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${UNISWAP_TRADE_API_BASE_URL}/swap`, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "x-universal-router-version": "2.0",
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Trade API /swap ${res.status}: ${await res.text()}`);
  }
  const parsed = (await res.json()) as unknown;
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Trade API /swap returned invalid payload");
  }
  return parsed as Record<string, unknown>;
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as ExecuteRequest;
    const { quoteResponse, signature } = body;

    if (!quoteResponse || typeof quoteResponse !== "object") {
      return NextResponse.json(
        { error: "quoteResponse is required" },
        { status: 400 },
      );
    }

    const apiKey = process.env.UNISWAP_API_KEY ?? "";
    if (!apiKey) {
      return NextResponse.json(
        { error: "UNISWAP_API_KEY is not set on server" },
        { status: 500 },
      );
    }

    // Build /swap body by spreading the full quote response.
    // Rules from the Uniswap Trading API (uniswap-ai SKILL.md):
    //  - NEVER wrap in { quote: ... } — causes "quote does not match any of the allowed types"
    //  - ALWAYS strip permitData and permitTransaction before spreading (they are null or typed-data objects)
    //  - CLASSIC:   include both signature + permitData, or neither
    //  - UniswapX (DUTCH_V2/V3/PRIORITY): include signature ONLY — permitData causes schema rejection
    const { permitData, permitTransaction, ...cleanQuote } = quoteResponse as {
      permitData?: Record<string, unknown> | null;
      permitTransaction?: unknown;
      [key: string]: unknown;
    };

    const swapBody: Record<string, unknown> = { ...cleanQuote };

    const routing = (quoteResponse["routing"] as string) ?? "";
    const isUniswapX =
      routing === "DUTCH_V2" ||
      routing === "DUTCH_V3" ||
      routing === "PRIORITY";

    if (isUniswapX) {
      // UniswapX: the order is encoded in quote.encodedOrder — fillers read it
      // directly. permitData must NOT be sent; the API schema rejects it.
      if (signature) swapBody.signature = signature;
    } else {
      // CLASSIC: Universal Router needs permitData to verify the Permit2
      // authorization on-chain. Both signature + permitData required together.
      if (signature && permitData && typeof permitData === "object") {
        swapBody.signature = signature;
        swapBody.permitData = permitData;
      }
    }

    const swapResponse = await callSwapApi(swapBody, apiKey);

    // ── Classic routing: return the transaction for the wallet to broadcast ──
    const swapTx = extractTxRequest(swapResponse);
    if (swapTx) {
      return NextResponse.json({ swapTx });
    }

    // ── UniswapX / Dutch routing: API submitted the order to fillers ──────────
    // For Dutch orders the Trading API receives the signed order, submits it to
    // UniswapX fillers, and returns { requestId, orderHash } — no user tx.
    const orderHash = swapResponse["orderHash"] as string | undefined;
    const requestId = swapResponse["requestId"] as string | undefined;
    if (orderHash || requestId) {
      return NextResponse.json({
        type: "UNISWAPX",
        orderHash: orderHash ?? null,
        requestId: requestId ?? null,
      });
    }

    return NextResponse.json(
      { error: "Swap transaction payload missing from Trade API response" },
      { status: 502 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
