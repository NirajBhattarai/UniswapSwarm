import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_ORCHESTRATOR_URL ?? "http://localhost:3000",
  ),
  title: "Uniswap Swarm",
  description:
    "Multi-agent DeFi cockpit — Researcher · Planner · Risk · Strategy · Critic · Executor, powered by 0G and CopilotKit.",
  icons: { icon: "/icon.png", shortcut: "/icon.png" },
  openGraph: {
    title: "Uniswap Swarm",
    description: "Multi-agent DeFi cockpit powered by 0G and CopilotKit.",
    images: [{ url: "/banner.png" }],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
