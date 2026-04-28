"use client";

import React from "react";
import { useAppKit, useAppKitAccount } from "@reown/appkit/react";

function shortAddress(address?: string): string {
  if (!address) return "";
  if (address.length < 10) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export const WalletConnectButton: React.FC = () => {
  const { open } = useAppKit();
  const { address, isConnected } = useAppKitAccount();

  return (
    <button
      type="button"
      onClick={() => open()}
      className="rounded-full border border-[#85e0ce] bg-[#85e0ce]/30 px-4 py-1 text-xs font-semibold text-[#0f766e] hover:bg-[#85e0ce]/45"
    >
      {isConnected ? `Wallet ${shortAddress(address)}` : "Connect Wallet"}
    </button>
  );
};
