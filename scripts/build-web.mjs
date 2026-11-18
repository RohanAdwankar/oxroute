import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

const lint = spawnSync(process.execPath, ["node_modules/eslint/bin/eslint.js", "--no-config-lookup", "--no-inline-config", "--config", "eslint.urls.config.mjs", "app"], {stdio: "inherit"});
if (lint.status !== 0) process.exit(lint.status ?? 1);

// Next loads its config more than once; every phase must share one version.
const build = spawnSync(process.execPath, ["node_modules/next/dist/bin/next", "build"], {
  stdio: "inherit",
  env: { ...process.env, OXROUTE_WEB_VERSION: randomUUID() },
});
process.exit(build.status ?? 1);
