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
};

export default nextConfig;
