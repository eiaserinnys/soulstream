import { defineConfig, devices } from "@playwright/test";
import { realpathSync } from "node:fs";

export default defineConfig({
  testDir: "./e2e", testMatch: "quota-pace-ticks.e2e.ts", workers: 1, retries: 0,
  timeout: 120_000, reporter: [["list"]],
  outputDir: "../.local/card1510-captures/results",
  use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:4199", actionTimeout: 10_000 },
  webServer: {
    command: `node "${realpathSync("node_modules/vite/bin/vite.js")}" --host 127.0.0.1 --port 4199 --strictPort`,
    url: "http://127.0.0.1:4199", reuseExistingServer: false, timeout: 60_000,
    env: { VITE_API_BASE: "http://127.0.0.1:5200" },
  },
});
