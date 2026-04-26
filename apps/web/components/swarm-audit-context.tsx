"use client";

/**
 * Swarm audit context — a tiny React context that lets render-time components
 * (e.g. the MessageFromA2A bubble) push 0G Storage writes and structured
 * agent payloads up to the parent SwarmChat without depending on the
 * AG-UI message array.
 *
 * Why this exists:
 *   The previous approach watched `useCopilotChatInternal().messages.length`
 *   and re-parsed every tool message on length change. That suffered from
 *   two problems:
 *     1. Tool message content can mutate AFTER the tool message slot is
 *        added to the array (the dependency `messages.length` won't trigger).
 *     2. Closure-captured `state` goes stale across runs.
 *
 *   `useCopilotAction` invokes `render(props)` whenever the action's
 *   lifecycle progresses, with `props.result` populated when status is
 *   `"complete"`. That render path already drives `MessageFromA2A`'s inline
 *   storage chips successfully — so we use the same signal to feed the
 *   sidebar audit card.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
} from "react";
import type { AgentStorageWrite } from "./types";

type AuditAPI = {
  recordStorageWrites: (writes: AgentStorageWrite[]) => void;
};

const SwarmAuditContext = createContext<AuditAPI | null>(null);

type ProviderProps = {
  children: React.ReactNode;
  /**
   * Existing storage trail from the parent state. Used purely to seed the
   * dedupe set on first mount — subsequent dedupe is handled by an internal
   * Set ref so we don't need a render every time we record.
   */
  storage?: AgentStorageWrite[];
  onStorageWrites: (fresh: AgentStorageWrite[]) => void;
};

export const SwarmAuditProvider: React.FC<ProviderProps> = ({
  children,
  storage,
  onStorageWrites,
}) => {
  // Internal dedupe set keyed by `${key}:${hash}:${ts}`. Survives across
  // renders so we never double-record the same write.
  const seenRef = useRef<Set<string>>(new Set());

  // Seed `seenRef` with whatever the parent already has — guards against
  // hot-module reloads or remounts dropping the dedupe set.
  React.useEffect(() => {
    if (!storage) return;
    for (const w of storage) {
      seenRef.current.add(`${w.key}:${w.hash}:${w.ts}`);
    }
    // We intentionally only seed once per mount — subsequent updates flow
    // through `recordStorageWrites` and the parent state is the source of
    // truth.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const recordStorageWrites = useCallback(
    (writes: AgentStorageWrite[]) => {
      if (!Array.isArray(writes) || writes.length === 0) return;
      const fresh: AgentStorageWrite[] = [];
      for (const w of writes) {
        if (
          !w ||
          typeof w.key !== "string" ||
          typeof w.hash !== "string" ||
          typeof w.ts !== "number"
        ) {
          continue;
        }
        const id = `${w.key}:${w.hash}:${w.ts}`;
        if (seenRef.current.has(id)) continue;
        seenRef.current.add(id);
        fresh.push(w);
      }
      if (fresh.length > 0) onStorageWrites(fresh);
    },
    [onStorageWrites],
  );

  const api = useMemo<AuditAPI>(
    () => ({ recordStorageWrites }),
    [recordStorageWrites],
  );

  return (
    <SwarmAuditContext.Provider value={api}>
      {children}
    </SwarmAuditContext.Provider>
  );
};

export const useSwarmAudit = (): AuditAPI => {
  const ctx = useContext(SwarmAuditContext);
  if (!ctx) {
    // Fall back to a noop so MessageFromA2A doesn't crash if rendered
    // outside a provider (e.g. in Storybook / tests).
    return { recordStorageWrites: () => {} };
  }
  return ctx;
};
