import { defineConfig, devices } from "@playwright/test";
import { realpathSync } from "node:fs";

export default defineConfig({
  testDir: "./e2e", testMatch: "quota-session-start.e2e.ts", workers: 1, retries: 0,
  timeout: 60_000, reporter: [["list"]],
  outputDir: "../../../.local/artifacts/20261003-quota-session-start/results",
  use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:45291", actionTimeout: 5_000 },
  webServer: {
    command: `node "${realpathSync("node_modules/vite/bin/vite.js")}" --host 127.0.0.1 --port 45291 --strictPort`,
    url: "http://127.0.0.1:45291", reuseExistingServer: false, timeout: 60_000,
    env: { VITE_API_BASE: "http://127.0.0.1:5200" },
  },
});
