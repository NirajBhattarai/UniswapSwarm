import type { NextConfig } from "next";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// apps/web directory
const appDir = dirname(fileURLToPath(import.meta.url));
// monorepo root (two levels up from apps/web)
const monorepoRoot = resolve(appDir, "../..");

const nextConfig: NextConfig = {
  turbopack: {
    root: monorepoRoot,
  },
  webpack: (config) => {
    const ignoredWarnings: RegExp[] = [
      /Critical dependency: the request of a dependency is an expression/,
    ];

    const ignoredModules: RegExp[] = [
      /node_modules[\\/]\.pnpm[\\/](ox|viem)@/,
      /node_modules[\\/]@whatwg-node[\\/]fetch[\\/]dist[\\/]node-ponyfill/,
    ];

    const existing = config.ignoreWarnings ?? [];
    config.ignoreWarnings = [
      ...existing,
      (warning: { message?: string; module?: { resource?: string } }) => {
        const message = warning.message ?? "";
        const resource = warning.module?.resource ?? "";
        return (
          ignoredWarnings.some((r) => r.test(message)) &&
          ignoredModules.some((r) => r.test(resource))
        );
      },
    ];
    return config;
  },
};

export default nextConfig;
