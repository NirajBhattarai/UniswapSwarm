"use client";

import { useState } from "react";
import { useAppKitAccount } from "@reown/appkit/react";
import { CopilotKit } from "@copilotkit/react-core";
import { SwarmAgentOutputs } from "../components/SwarmAgentOutputs";
import { SwarmChat } from "../components/swarm-chat";
import { WalletConnectButton } from "../components/wallet/WalletConnectButton";
import { SwarmHistoryPanel } from "../components/history/SwarmHistoryPanel";
import { SWARM_AGENTS } from "../lib/swarm-agents";
import type { SwarmAggregateState } from "../components/types";

function shortAddress(address?: string): string {
  if (!address) return "";
  if (address.length < 10) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export default function Home() {
  const [state, setState] = useState<SwarmAggregateState>({});
  const { isConnected, address } = useAppKitAccount();

  return (
    // h-screen + overflow-hidden caps the page at one viewport so a long
    // chat history scrolls inside the chat column instead of pushing the
    // whole document taller (which would create a window-level scrollbar).
    <main className="relative h-screen w-screen overflow-hidden bg-[#e9ebf3] text-[#010507]">
      <div className="pointer-events-none absolute -left-24 top-24 h-80 w-80 rounded-full bg-[#ffb86e]/35 blur-[100px]" />
      <div className="pointer-events-none absolute right-[-4rem] top-[-2rem] h-96 w-96 rounded-full bg-[#98c8ff]/30 blur-[120px]" />
      <div className="pointer-events-none absolute bottom-[-6rem] left-[35%] h-72 w-72 rounded-full bg-[#85e0ce]/35 blur-[100px]" />

      <div className="relative mx-auto flex h-full w-full max-w-[1760px] gap-3 p-3">
        {/* ── Chat column ───────────────────────────────────────────────── */}
        <section className="flex h-full w-full max-w-[520px] min-h-0 flex-shrink-0 flex-col overflow-hidden rounded-2xl border-2 border-white bg-white/65 shadow-[0_24px_70px_rgba(27,35,57,0.18)] backdrop-blur-md">
          <div className="border-b border-[#d9dbe5] px-6 py-5">
            <div className="flex items-center justify-between gap-3">
              <h1 className="text-2xl font-semibold text-[#0b1021]">
                Uniswap Swarm
              </h1>
              <div className="flex items-center gap-2">
                {isConnected && (
                  <span className="rounded-full border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-700">
                    {shortAddress(address)}
                  </span>
                )}
                <WalletConnectButton />
              </div>
            </div>
            <p className="mt-1 text-sm text-[#57575b]">
              CopilotKit A2A multi-agent cockpit
            </p>
            <p className="mt-2 text-xs text-[#7b7b88]">
              Orchestrator → Researcher → Planner → Risk → Strategy → Critic →
              Executor
            </p>
          </div>

          <div className="flex flex-wrap gap-1.5 border-b border-[#d9dbe5] bg-white/55 px-4 py-3">
            {SWARM_AGENTS.map((agent) => (
              <span
                key={agent.id}
                className="rounded-full border border-slate-300 bg-white/80 px-2.5 py-0.5 text-[11px] font-semibold text-slate-700"
              >
                {agent.emoji} {agent.badge}
              </span>
            ))}
          </div>

          {/*
            The chat-content wrapper has `min-h-0` + `flex-1` + `overflow-hidden`
            so its child <CopilotChat> can fill the remaining height and
            scroll its internal message list without growing this column.
          */}
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-3">
            {isConnected ? (
              <CopilotKit
                runtimeUrl={
                  process.env.NEXT_PUBLIC_COPILOTKIT_RUNTIME_URL ??
                  "/api/copilotkit"
                }
                agent="swarm_chat"
                showDevConsole={false}
                headers={{ "x-wallet-address": address ?? "" }}
              >
                <SwarmChat state={state} onState={setState} />
              </CopilotKit>
            ) : (
              <div className="flex h-full items-center justify-center rounded-xl border border-dashed border-slate-300 bg-white/60 p-6 text-center">
                <div>
                  <p className="text-sm font-semibold text-slate-800">
                    Connect wallet to use Swarm Chat
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    For security, only connected wallets can access chat and
                    execute swap approvals.
                  </p>
                  <div className="mt-4 flex justify-center">
                    <WalletConnectButton />
                  </div>
                </div>
              </div>
            )}
          </div>
        </section>

        {/* ── Sidebar / structured-data column ──────────────────────────── */}
        <section className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border-2 border-white bg-white/45 shadow-[0_24px_80px_rgba(27,35,57,0.16)] backdrop-blur-md">
          <header className="border-b border-[#d9dbe5] px-5 py-4 lg:px-7">
            <p className="text-xs uppercase tracking-[0.2em] text-[#6f7390]">
              Agent Outputs
            </p>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-2xl font-semibold text-[#0f172a]">
                Live A2A Pipeline
              </h2>
              <span className="rounded-full border border-[#85e0ce] bg-[#85e0ce]/30 px-4 py-1 text-xs font-semibold text-[#0f766e]">
                CopilotKit • A2A Middleware • Gemini
              </span>
            </div>
            <p className="mt-2 text-xs text-[#475467]">
              Each box below mirrors the live JSON returned by a standalone A2A
              agent server. The chat on the left visualises every orchestrator →
              agent handoff.
            </p>
          </header>

          <div className="min-h-0 flex-1 overflow-hidden p-4">
            <div className="grid h-full min-h-0 grid-rows-[minmax(0,2fr)_minmax(0,1fr)] gap-3">
              <SwarmAgentOutputs state={state} />
              <SwarmHistoryPanel walletAddress={address} />
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
