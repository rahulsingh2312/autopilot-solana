import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The repo root sits above this app; without this Turbopack walks up and
  // finds an unrelated lockfile in the home directory.
  turbopack: { root: __dirname },
};

export default nextConfig;
