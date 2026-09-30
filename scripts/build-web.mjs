import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

// Next loads its config more than once; every phase must share one version.
const build = spawnSync(process.execPath, ["node_modules/next/dist/bin/next", "build"], {
  stdio: "inherit",
  env: { ...process.env, OXROUTE_WEB_VERSION: randomUUID() },
});
process.exit(build.status ?? 1);
