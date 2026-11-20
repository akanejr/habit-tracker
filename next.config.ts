import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Development-only cross-origin asset requests for the hosted preview and local testing.
  allowedDevOrigins: ["*.e2b.app", "127.0.0.1", "localhost"],
};

export default nextConfig;
