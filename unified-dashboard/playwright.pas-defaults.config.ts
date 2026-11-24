import { defineConfig, devices } from "@playwright/test";
import { realpathSync } from "node:fs";

export default defineConfig({
  testDir: "./e2e", testMatch: "pas-defaults.e2e.ts", workers: 1, retries: 0,
  timeout: 120_000, reporter: "list",
  outputDir: "../../../.local/tmp/card1836/pas-defaults-web/pas-e2e-results",
  use: { ...devices["Desktop Chrome"], serviceWorkers: "block", baseURL: "http://127.0.0.1:4237" },
  webServer: {
    command: `node "${realpathSync("node_modules/vite/bin/vite.js")}" --host 127.0.0.1 --port 4237 --strictPort`,
    url: "http://127.0.0.1:4237", reuseExistingServer: false,
    env: { VITE_API_BASE: "http://127.0.0.1:5299" }, timeout: 60_000,
  },
});
