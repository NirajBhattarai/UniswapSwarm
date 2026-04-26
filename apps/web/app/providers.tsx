"use client";

import { CopilotKit } from "@copilotkit/react-core";

type ProvidersProps = {
  children: React.ReactNode;
};

export function Providers({ children }: ProvidersProps) {
  const runtimeUrl =
    process.env.NEXT_PUBLIC_COPILOTKIT_RUNTIME_URL ?? "/api/copilotkit";

  return (
    <CopilotKit
      runtimeUrl={runtimeUrl}
      agent="swarm_chat"
      showDevConsole={false}
    >
      {children}
    </CopilotKit>
  );
}
