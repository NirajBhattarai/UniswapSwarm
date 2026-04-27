"use client";

import "@xyflow/react/dist/style.css";

import React, { useCallback, useEffect, useMemo } from "react";
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  type NodeTypes,
} from "@xyflow/react";

import { SwarmPipelineStageBody } from "../data/SwarmDataCards";
import type { SwarmAggregateState } from "../types";
import { DataFlowEdge } from "./DataFlowEdge";
import {
  SWARM_PIPELINE_STAGE_ORDER,
  SWARM_PIPELINE_NODE_IDS,
} from "./swarm-pipeline-ids";

const NODE_TYPE_PIPELINE_CARD = "pipelineCard";
const EDGE_TYPE_DATA_FLOW = "dataFlow";

/** Width of each pipeline card node (px). */
const CARD_WIDTH_PX = 320;
/** Horizontal distance between consecutive node left edges (px). Card + gap. */
const HORIZONTAL_NODE_PITCH = 380;
/** Vertical distance between row tops (px). Enough for tallest card + gap. */
const VERTICAL_ROW_PITCH = 420;
/** How many nodes sit on a single row before wrapping to the next. */
const NODES_PER_ROW = 3;

/**
 * Snake-layout position for pipeline index `i`.
 *
 * Row 0 (indices 0-2): left → right
 * Row 1 (indices 3-5): right → left  (so the cross-row edge is vertical)
 * Row 2 (indices 6-7): left → right
 */
function getSnakePosition(index: number): { x: number; y: number } {
  const row = Math.floor(index / NODES_PER_ROW);
  const col = index % NODES_PER_ROW;
  const isRTL = row % 2 === 1; // odd rows go right-to-left
  const x = isRTL
    ? (NODES_PER_ROW - 1 - col) * HORIZONTAL_NODE_PITCH
    : col * HORIZONTAL_NODE_PITCH;
  return { x, y: row * VERTICAL_ROW_PITCH };
}

/**
 * Returns the React Flow handle IDs to use for an edge between two pipeline
 * indices.  Same-row edges are horizontal (left ↔ right); cross-row edges are
 * vertical (bottom → top) because the snake layout puts the row-end and
 * row-start nodes at the same x coordinate.
 */
function getEdgeHandles(
  sourceIndex: number,
  targetIndex: number,
): { sourceHandle: string; targetHandle: string } {
  const sourceRow = Math.floor(sourceIndex / NODES_PER_ROW);
  const targetRow = Math.floor(targetIndex / NODES_PER_ROW);
  if (sourceRow === targetRow) {
    const isRTL = sourceRow % 2 === 1;
    return isRTL
      ? { sourceHandle: "src-left", targetHandle: "tgt-right" }
      : { sourceHandle: "src-right", targetHandle: "tgt-left" };
  }
  return { sourceHandle: "src-bottom", targetHandle: "tgt-top" };
}

/** Per-agent top accent bar colour and active-state glow colour. */
const NODE_ACCENT: Record<string, { bar: string; glow: string }> = {
  [SWARM_PIPELINE_NODE_IDS.userIntent]: {
    bar: "#8b5cf6",
    glow: "rgba(139,92,246,0.25)",
  },
  [SWARM_PIPELINE_NODE_IDS.researcher]: {
    bar: "#10b981",
    glow: "rgba(16,185,129,0.25)",
  },
  [SWARM_PIPELINE_NODE_IDS.planner]: {
    bar: "#3b82f6",
    glow: "rgba(59,130,246,0.25)",
  },
  [SWARM_PIPELINE_NODE_IDS.risk]: {
    bar: "#f59e0b",
    glow: "rgba(245,158,11,0.25)",
  },
  [SWARM_PIPELINE_NODE_IDS.strategy]: {
    bar: "#0ea5e9",
    glow: "rgba(14,165,233,0.25)",
  },
  [SWARM_PIPELINE_NODE_IDS.critic]: {
    bar: "#f43f5e",
    glow: "rgba(244,63,94,0.25)",
  },
  [SWARM_PIPELINE_NODE_IDS.executor]: {
    bar: "#84cc16",
    glow: "rgba(132,204,22,0.25)",
  },
  [SWARM_PIPELINE_NODE_IDS.storage]: {
    bar: "#64748b",
    glow: "rgba(100,116,139,0.25)",
  },
};

function riskHasBlocked(risk: SwarmAggregateState["risk"]): boolean {
  if (!risk?.length) return false;
  return risk.some((e) => e.passed === false);
}

function computeStatus(
  id: string,
  state: SwarmAggregateState,
): "empty" | "filled" | "warning" {
  switch (id) {
    case SWARM_PIPELINE_NODE_IDS.userIntent:
      return state.request?.trim() ? "filled" : "empty";
    case SWARM_PIPELINE_NODE_IDS.researcher:
      return state.research ? "filled" : "empty";
    case SWARM_PIPELINE_NODE_IDS.planner:
      return state.plan ? "filled" : "empty";
    case SWARM_PIPELINE_NODE_IDS.risk: {
      if (!state.risk?.length) return "empty";
      return riskHasBlocked(state.risk) ? "warning" : "filled";
    }
    case SWARM_PIPELINE_NODE_IDS.strategy:
      return state.strategy ? "filled" : "empty";
    case SWARM_PIPELINE_NODE_IDS.critic:
      return state.critique ? "filled" : "empty";
    case SWARM_PIPELINE_NODE_IDS.executor:
      return state.execution ? "filled" : "empty";
    case SWARM_PIPELINE_NODE_IDS.storage:
      return state.storage?.length ? "filled" : "empty";
    default:
      return "empty";
  }
}

function isNodeDone(id: string, state: SwarmAggregateState): boolean {
  return computeStatus(id, state) !== "empty";
}

function edgeIndexShouldAnimate(
  edgeIndex: number,
  firstNotDoneIndex: number,
): boolean {
  return firstNotDoneIndex > 0 && edgeIndex < firstNotDoneIndex;
}

export type PipelineCardNodeData = {
  sectionId: string;
  state: SwarmAggregateState;
};

function PipelineCardNode({
  data,
  selected,
}: NodeProps<Node<PipelineCardNodeData, typeof NODE_TYPE_PIPELINE_CARD>>) {
  const { sectionId, state } = data;
  const status = computeStatus(sectionId, state);
  const accent = NODE_ACCENT[sectionId] ?? {
    bar: "#94a3b8",
    glow: "rgba(148,163,184,0.2)",
  };

  const statusLabel =
    status === "filled"
      ? "✓ Done"
      : status === "warning"
        ? "⚠ Warning"
        : "· Waiting";

  const statusTone =
    status === "filled"
      ? "bg-emerald-100 text-emerald-700 border-emerald-200"
      : status === "warning"
        ? "bg-amber-100 text-amber-700 border-amber-200"
        : "bg-slate-100 text-slate-400 border-slate-200";

  return (
    <>
      {/* ── Four directional handles (snake layout needs all four) ── */}
      <Handle
        id="tgt-left"
        type="target"
        position={Position.Left}
        className="!h-2 !w-2 !border-2 !border-white !bg-slate-300"
        isConnectable={false}
      />
      <Handle
        id="tgt-top"
        type="target"
        position={Position.Top}
        className="!h-2 !w-2 !border-2 !border-white !bg-slate-300"
        isConnectable={false}
      />
      <Handle
        id="tgt-right"
        type="target"
        position={Position.Right}
        className="!h-2 !w-2 !border-2 !border-white !bg-slate-300"
        isConnectable={false}
      />
      <Handle
        id="src-left"
        type="source"
        position={Position.Left}
        className="!h-2 !w-2 !border-2 !border-white !bg-slate-300"
        isConnectable={false}
      />
      <Handle
        id="src-right"
        type="source"
        position={Position.Right}
        className="!h-2 !w-2 !border-2 !border-white !bg-slate-300"
        isConnectable={false}
      />
      <Handle
        id="src-bottom"
        type="source"
        position={Position.Bottom}
        className="!h-2 !w-2 !border-2 !border-white !bg-slate-300"
        isConnectable={false}
      />

      {/* Card shell */}
      <div
        className={[
          "overflow-hidden rounded-2xl border border-slate-200/80 bg-white/95 shadow-lg",
          "transition-all duration-200",
          "pipeline-card-in",
          selected
            ? "ring-2 ring-[#85e0ce] ring-offset-2 ring-offset-white/60 shadow-2xl"
            : "hover:shadow-xl hover:-translate-y-px",
        ]
          .filter(Boolean)
          .join(" ")}
        style={{
          width: CARD_WIDTH_PX,
          boxShadow: selected
            ? `0 0 0 2px #85e0ce, 0 20px 40px ${accent.glow}`
            : `0 4px 20px ${accent.glow}, 0 1px 4px rgba(0,0,0,0.06)`,
        }}
      >
        {/* Coloured top accent bar */}
        <div
          className="h-[3px] w-full shrink-0"
          style={{ backgroundColor: accent.bar }}
        />

        {/* Status badge row */}
        <div className="flex items-center justify-end px-3 pt-2 pb-0.5">
          <span
            className={[
              "rounded-full border px-2 py-0.5 text-[9px] font-semibold tracking-wide",
              statusTone,
            ].join(" ")}
          >
            {statusLabel}
          </span>
        </div>

        {/* Agent card body — scrollable */}
        <div className="max-h-[320px] min-h-[110px] overflow-y-auto px-3 pb-4">
          <SwarmPipelineStageBody sectionId={sectionId} state={state} />
        </div>
      </div>
    </>
  );
}

const nodeTypes: NodeTypes = {
  [NODE_TYPE_PIPELINE_CARD]: PipelineCardNode,
};

const edgeTypes = {
  [EDGE_TYPE_DATA_FLOW]: DataFlowEdge,
};

function buildGraph(
  state: SwarmAggregateState,
  selectedId: string | null,
): {
  nodes: Node<PipelineCardNodeData, typeof NODE_TYPE_PIPELINE_CARD>[];
  edges: Edge[];
} {
  const order = SWARM_PIPELINE_STAGE_ORDER;

  const nodes: Node<PipelineCardNodeData, typeof NODE_TYPE_PIPELINE_CARD>[] =
    order.map((sectionId, index) => ({
      id: sectionId,
      type: NODE_TYPE_PIPELINE_CARD,
      position: getSnakePosition(index),
      data: { sectionId, state },
      selected: selectedId === sectionId,
      draggable: false,
      selectable: true,
      // sourcePosition/targetPosition are only defaults; explicit handle IDs
      // in each edge override these for the actual path routing.
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      style: { width: CARD_WIDTH_PX },
    }));

  const n = order.length;
  let firstNotDoneIndex = 0;
  for (; firstNotDoneIndex < n; firstNotDoneIndex++) {
    const id = order[firstNotDoneIndex];
    if (id == null) break;
    if (!isNodeDone(id, state)) break;
  }

  const edges: Edge[] = [];
  for (let i = 0; i < order.length - 1; i++) {
    const source = order[i];
    const target = order[i + 1];
    if (!source || !target) continue;
    const { sourceHandle, targetHandle } = getEdgeHandles(i, i + 1);
    edges.push({
      id: `e-${source}-${target}`,
      source,
      target,
      sourceHandle,
      targetHandle,
      type: EDGE_TYPE_DATA_FLOW,
      data: { flowActive: edgeIndexShouldAnimate(i, firstNotDoneIndex) },
    });
  }

  return { nodes, edges };
}

type FitViewOnReadyProps = {
  nodeCount: number;
};

function FitViewOnReady({ nodeCount }: FitViewOnReadyProps) {
  const { fitView } = useReactFlow();
  const ranRef = React.useRef(false);

  // Initial fit
  useEffect(() => {
    if (nodeCount === 0) return;
    if (ranRef.current) return;
    ranRef.current = true;
    const t = requestAnimationFrame(() => {
      fitView({ padding: 0.1, duration: 350, maxZoom: 1.0, minZoom: 0.06 });
    });
    return () => cancelAnimationFrame(t);
  }, [nodeCount, fitView]);

  // Re-fit whenever the browser window resizes so cards always fill the panel
  useEffect(() => {
    if (nodeCount === 0) return;
    const handler = () => {
      fitView({ padding: 0.1, duration: 250, maxZoom: 1.0, minZoom: 0.06 });
    };
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, [nodeCount, fitView]);

  return null;
}

export type SwarmPipelineFlowProps = {
  state: SwarmAggregateState;
  selectedId: string | null;
  onSelect: (id: string) => void;
};

function SwarmPipelineFlowInner({
  state,
  selectedId,
  onSelect,
}: SwarmPipelineFlowProps) {
  const { nodes, edges } = useMemo(
    () => buildGraph(state, selectedId),
    [state, selectedId],
  );

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      onSelect(node.id);
    },
    [onSelect],
  );

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      defaultEdgeOptions={{ type: EDGE_TYPE_DATA_FLOW }}
      onNodeClick={onNodeClick}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable
      proOptions={{ hideAttribution: true }}
      className="bg-gradient-to-br from-slate-50/60 to-white/30"
      minZoom={0.05}
      maxZoom={1.5}
      panOnScroll
      zoomOnScroll
      zoomOnPinch
    >
      <Background gap={24} size={1} color="#cbd5e1" className="opacity-40" />
      <Controls
        showInteractive={false}
        className="!m-3 !rounded-xl !border !border-slate-200 !shadow-md"
      />
      <FitViewOnReady nodeCount={nodes.length} />
    </ReactFlow>
  );
}

export function SwarmPipelineFlow(props: SwarmPipelineFlowProps) {
  return (
    <div className="h-full min-h-0 w-full">
      <ReactFlowProvider>
        <SwarmPipelineFlowInner {...props} />
      </ReactFlowProvider>
    </div>
  );
}
