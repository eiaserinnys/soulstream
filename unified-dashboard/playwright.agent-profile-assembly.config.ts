import { defineConfig, devices } from "@playwright/test";
import { realpathSync } from "node:fs";

export default defineConfig({
  testDir: "./e2e", testMatch: "agent-profile-assembly*.e2e.ts", workers: 2, retries: 0,
  timeout: 120_000, reporter: [["list"]], outputDir: "../.local/card1783-captures/results",
  use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:4304", actionTimeout: 5_000 },
  webServer: {
    command: `node "${realpathSync("node_modules/vite/bin/vite.js")}" --host 127.0.0.1 --port 4304 --strictPort`,
    url: "http://127.0.0.1:4304", reuseExistingServer: false,
    env: { VITE_API_BASE: "http://127.0.0.1:5200" }, timeout: 60_000,
  },
});
