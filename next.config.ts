import type { NextConfig } from "next";

// The browser only ever talks to this origin. Everything under /api is
// forwarded to the daemon, which keeps the web UI free of CORS handling and
// lets the daemon stay bound to localhost in production.
const daemon = process.env.OXROUTE_DAEMON ?? "http://127.0.0.1:8787";

const nextConfig: NextConfig = {
  // This repo keeps its own CLAUDE.md; Next's generated one would describe
  // the web UI as if it were the whole project.
  agentRules: false,

  async rewrites() {
    return [{ source: "/api/:path*", destination: `${daemon}/api/:path*` }];
  },
};

export default nextConfig;
