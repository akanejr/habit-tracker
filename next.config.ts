import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Development-only cross-origin asset requests for the hosted preview.
  allowedDevOrigins: ["*.e2b.app"],
};

export default nextConfig;
