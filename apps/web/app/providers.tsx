"use client";

import { ensureAppKitInit } from "../lib/reown";

type ProvidersProps = {
  children: React.ReactNode;
};

// Initialises Reown AppKit (wallet connection) for the whole app.
// CopilotKit is mounted in page.tsx so it can receive the connected wallet
// address directly as a request header, which the API route forwards to the
// orchestration agent for reliable DynamoDB history attribution.
export function Providers({ children }: ProvidersProps) {
  ensureAppKitInit();
  return <>{children}</>;
}
