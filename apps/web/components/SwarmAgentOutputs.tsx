"use client";

import React, { useState } from "react";

import { SwarmPipelineFlow } from "./pipeline/SwarmPipelineFlow";
import type { SwarmAggregateState } from "./types";

type SwarmAgentOutputsProps = {
  state: SwarmAggregateState;
};

/**
 * Fills the Agent Outputs column with a single React Flow canvas: each
 * pipeline stage is a node that embeds the same card content as before.
 */
export function SwarmAgentOutputs({ state }: SwarmAgentOutputsProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  return (
    <div className="h-full min-h-0 w-full overflow-hidden rounded-xl border border-[#d9dbe5] bg-white/40">
      <SwarmPipelineFlow
        state={state}
        selectedId={selectedId}
        onSelect={setSelectedId}
      />
    </div>
  );
}
