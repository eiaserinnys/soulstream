import { defineConfig, devices } from "@playwright/test";
import { realpathSync } from "node:fs";

const vite = realpathSync("node_modules/vite/bin/vite.js");

export default defineConfig({
  testDir: "./e2e",
  testMatch: "usage-stats-485.qa.ts",
  workers: 1,
  retries: 0,
  timeout: 90_000,
  reporter: [["list"]],
  outputDir: process.env.USAGE_STATS_CAPTURE_DIR ? `${process.env.USAGE_STATS_CAPTURE_DIR}/results` : "test-results/usage-stats-485",
  use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:4393", actionTimeout: 10_000, navigationTimeout: 15_000 },
  webServer: {
    command: `MOCKUP=usage-stats-485 node "${vite}" --config vite.mockup.config.ts --host 127.0.0.1 --port 4393 --strictPort`,
    url: "http://127.0.0.1:4393/frame.html",
    reuseExistingServer: false,
    timeout: 60_000,
    env: { VITE_API_BASE: "http://127.0.0.1:9" },
  },
});
