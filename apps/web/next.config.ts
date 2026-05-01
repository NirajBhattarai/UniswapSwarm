import type { NextConfig } from "next";

/**
 * Standard Next.js config: environment variables are loaded from apps/web/.env by default.
 * No custom env or monorepo root logic.
 */
const nextConfig: NextConfig = {
  // Keep CopilotKit runtime + its deps out of the Turbopack/webpack server bundle.
  // They use dynamic require() internally (graphql-yoga / @whatwg-node/fetch)
  // which triggers "Critical dependency" warnings when bundled.
  serverExternalPackages: [
    "@copilotkit/runtime",
    "graphql-yoga",
    "@whatwg-node/fetch",
    "@whatwg-node/server",
  ],

  // Next.js 16 enables Turbopack by default. Declaring an empty config here
  // satisfies the "webpack config without turbopack config" guard and silences
  // the build error. The ox/viem dynamic-require warning is benign and does
  // not affect runtime behaviour.
  turbopack: {},
};

export default nextConfig;
