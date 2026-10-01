import { defineConfig, devices } from "@playwright/test";
import { realpathSync } from "node:fs";
export default defineConfig({
  testDir: "./e2e",
  testMatch: "card-orchestration-settings.e2e.ts",
  workers: 1,
  retries: 0,
  timeout: 60000,
  reporter: "list",
  outputDir: "../../../.local/artifacts/20261001-card-orchestration/ui/results",
  use: { ...devices["Desktop Chrome"], serviceWorkers: "block", baseURL: "http://127.0.0.1:4196" },
  webServer: {
    command: `node "${realpathSync("node_modules/vite/bin/vite.js")}" preview --host 127.0.0.1 --port 4196 --strictPort`,
    url: "http://127.0.0.1:4196",
    reuseExistingServer: false,
    env: { VITE_API_BASE: "http://127.0.0.1:5200" },
    timeout: 60000,
  },
});
