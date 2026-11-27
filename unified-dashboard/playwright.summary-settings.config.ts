import { defineConfig, devices } from "@playwright/test";
import { realpathSync } from "node:fs";

export default defineConfig({
  testDir: "./e2e", testMatch: "summary-settings.e2e.ts", workers: 1, retries: 0,
  timeout: 120_000, reporter: "list",
  outputDir: "../.local/summary-settings/playwright-results",
  use: { ...devices["Desktop Chrome"], serviceWorkers: "block", baseURL: "http://127.0.0.1:4247" },
  webServer: {
    command: `node "${realpathSync("node_modules/vite/bin/vite.js")}" --host 127.0.0.1 --port 4247 --strictPort`,
    url: "http://127.0.0.1:4247", reuseExistingServer: false,
    env: { VITE_API_BASE: "http://127.0.0.1:5399" }, timeout: 60_000,
  },
});
