import { NextRequest, NextResponse } from "next/server";
const UNISWAP_TRADE_API_BASE_URL = "https://trade-api.gateway.uniswap.org/v1";

type TxRequestLike = {
  to: string;
  data: string;
  value?: string;
};

type PrepareRequest = {
  strategy?: {
    tokenIn: string;
    tokenOut: string;
    amountInWei: string;
    slippagePct: number;
  };
  tokenIn?: string;
  tokenOut?: string;
  amountInWei?: string;
  slippagePct?: number;
  walletAddress?: string;
};

const NATIVE_ETH = "0x0000000000000000000000000000000000000000";

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
    payload["approval"],
    payload["swap"],
    payload["permitTransaction"],
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

async function callTradeApi(
  path: "check_approval" | "quote" | "swap",
  body: Record<string, unknown>,
  apiKey: string,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${UNISWAP_TRADE_API_BASE_URL}/${path}`, {
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
    throw new Error(`Trade API /${path} ${res.status}: ${await res.text()}`);
  }
  const parsed = (await res.json()) as unknown;
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`Trade API /${path} returned invalid payload`);
  }
  return parsed as Record<string, unknown>;
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as PrepareRequest;
    const wallet = body.walletAddress;
    const tokenIn = body.tokenIn ?? body.strategy?.tokenIn;
    const tokenOut = body.tokenOut ?? body.strategy?.tokenOut;
    const amountInWei = body.amountInWei ?? body.strategy?.amountInWei;
    const slippagePct = body.slippagePct ?? body.strategy?.slippagePct ?? 1.5;

    if (!wallet || !tokenIn || !tokenOut || !amountInWei) {
      return NextResponse.json(
        {
          error:
            "walletAddress plus tokenIn/tokenOut/amountInWei are required (direct or via strategy)",
        },
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

    const normalizedTokenIn = tokenIn === "native" ? NATIVE_ETH : tokenIn;
    const approvalTx =
      normalizedTokenIn === NATIVE_ETH
        ? null
        : extractTxRequest(
            await callTradeApi(
              "check_approval",
              {
                walletAddress: wallet,
                token: normalizedTokenIn,
                amount: amountInWei,
                chainId: 1,
              },
              apiKey,
            ),
          );

    const quoteResponse = await callTradeApi(
      "quote",
      {
        tokenIn: normalizedTokenIn,
        tokenOut,
        amount: amountInWei,
        type: "EXACT_INPUT",
        tokenInChainId: 1,
        tokenOutChainId: 1,
        swapper: wallet,
        slippageTolerance: slippagePct,
        generatePermitAsTransaction: true,
      },
      apiKey,
    );

    const quote = quoteResponse["quote"];
    if (typeof quote !== "object" || quote === null) {
      return NextResponse.json(
        { error: "Trade API quote payload missing" },
        { status: 502 },
      );
    }

    const swapResponse = await callTradeApi("swap", { quote }, apiKey);
    const swapTx = extractTxRequest(swapResponse);
    if (!swapTx) {
      return NextResponse.json(
        { error: "Swap transaction payload missing from Trade API response" },
        { status: 502 },
      );
    }

    return NextResponse.json({
      approvalTx,
      swapTx,
      quote,
      requested: {
        tokenIn: normalizedTokenIn,
        tokenOut,
        amountInWei,
        slippagePct,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
