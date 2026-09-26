import type { NextConfig } from "next";

// The browser only ever talks to this origin. The events route is handled in
// app/api/events so its stream is not buffered by a rewrite; the remaining
// API is forwarded to the daemon, which stays bound to localhost.
const daemon = process.env.OXROUTE_DAEMON ?? "http://127.0.0.1:8787";

const nextConfig: NextConfig = {
  // The demo builds its own copy while a dev server is running in the same
  // checkout, and two builds cannot share one output directory.
  distDir: process.env.OXROUTE_DIST ?? ".next",

  // This repo keeps its own CLAUDE.md; Next's generated one would describe
  // the web UI as if it were the whole project.
  agentRules: false,

  // The daemon and dev.sh speak in 127.0.0.1, so the UI gets opened there
  // too. Next treats that as a foreign origin and blocks hot reload.
  allowedDevOrigins: ["127.0.0.1"],

  async rewrites() {
    return [{ source: "/api/:path*", destination: `${daemon}/api/:path*` }];
  },
};

export default nextConfig;
