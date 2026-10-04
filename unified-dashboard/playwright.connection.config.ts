import { defineConfig } from "@playwright/test";
import { realpathSync } from "node:fs";
export default defineConfig({
  testDir: "./e2e",
  testMatch: "connection-recovery.e2e.ts",
  workers: 1,
  retries: 0,
  timeout: 60000,
  reporter: [["list"]],
  outputDir: "../.local/connection-recovery/results",
  use: {
    baseURL: "http://127.0.0.1:52108",
    actionTimeout: 10000,
    trace: "retain-on-failure",
  },
  webServer: {
    command: `node --import "${realpathSync("../orch-server-ts/node_modules/tsx/dist/loader.mjs")}" e2e/connection-harness.ts`,
    url: "http://127.0.0.1:52107/ready",
    reuseExistingServer: false,
    timeout: 60000,
    env: { NODE_ENV: "development" },
  },
});
