"use client";

import { BaseEdge, getSmoothStepPath, type EdgeProps } from "@xyflow/react";

export type DataFlowEdgeData = { flowActive?: boolean };

/** Duration one comet takes to travel the full path. */
const COMET_DUR = "1.8s";
/** Three comets staggered evenly across the duration. */
const COMET_OFFSETS = ["0s", "0.6s", "1.2s"];

/**
 * Animated data-flow edge featuring:
 *
 * Idle   — thin dashed slate line with a slow marching-ants dash.
 * Active — glowing teal base line + animated running dashes + three
 *          staggered comet particles (glow halo → bright head → white core)
 *          that travel along the full SVG path so the animation follows
 *          every bend (horizontal, vertical, and corner turns in the snake).
 */
export function DataFlowEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  style,
  interactionWidth,
  data,
}: EdgeProps) {
  const [edgePath] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const flowActive =
    (data as DataFlowEdgeData | undefined)?.flowActive === true;

  const uid = id.replace(/[^a-zA-Z0-9_-]/g, "-");
  const glowFilterId = `glow-${uid}`;

  return (
    <>
      <defs>
        {/* Soft bloom filter for the glowing base line */}
        <filter id={glowFilterId} x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="2.5" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* ── Idle / base track ─────────────────────────────────────────── */}
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        interactionWidth={interactionWidth}
        style={{
          ...style,
          stroke: flowActive ? "#2dd4bf" : "#d1d5db",
          strokeWidth: flowActive ? 2 : 1.5,
          strokeDasharray: flowActive ? "none" : "5 6",
        }}
      />

      {flowActive && (
        <g style={{ pointerEvents: "none" }}>
          {/* ── Glowing teal base overlay ──────────────────────────────── */}
          <path
            d={edgePath}
            fill="none"
            stroke="#0d9488"
            strokeWidth={4}
            strokeLinecap="round"
            opacity={0.35}
            filter={`url(#${glowFilterId})`}
          />

          {/* ── Running animated dashes ────────────────────────────────── */}
          <path
            d={edgePath}
            fill="none"
            stroke="#5eead4"
            strokeWidth={2}
            strokeLinecap="round"
            strokeDasharray="8 14"
            opacity={0.9}
          >
            <animate
              attributeName="stroke-dashoffset"
              from="0"
              to="-22"
              dur="0.7s"
              repeatCount="indefinite"
            />
          </path>

          {/* ── Three staggered comet particles ───────────────────────── */}
          {COMET_OFFSETS.map((begin, i) => (
            <g key={i}>
              {/* Outer halo */}
              <circle cx={0} cy={0} r={11} fill="#0d9488" opacity={0.12}>
                <animateMotion
                  dur={COMET_DUR}
                  begin={begin}
                  repeatCount="indefinite"
                  path={edgePath}
                  rotate="auto"
                />
              </circle>
              {/* Mid glow */}
              <circle cx={0} cy={0} r={6} fill="#14b8a6" opacity={0.5}>
                <animateMotion
                  dur={COMET_DUR}
                  begin={begin}
                  repeatCount="indefinite"
                  path={edgePath}
                  rotate="auto"
                />
              </circle>
              {/* Bright head */}
              <circle cx={0} cy={0} r={3.5} fill="#2dd4bf">
                <animateMotion
                  dur={COMET_DUR}
                  begin={begin}
                  repeatCount="indefinite"
                  path={edgePath}
                  rotate="auto"
                />
              </circle>
              {/* White core */}
              <circle cx={0} cy={0} r={1.4} fill="white" opacity={0.95}>
                <animateMotion
                  dur={COMET_DUR}
                  begin={begin}
                  repeatCount="indefinite"
                  path={edgePath}
                  rotate="auto"
                />
              </circle>
            </g>
          ))}
        </g>
      )}
    </>
  );
}
