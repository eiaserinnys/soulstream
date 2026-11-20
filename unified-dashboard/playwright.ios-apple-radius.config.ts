import { defineConfig, devices } from "@playwright/test";
import { realpathSync } from "node:fs";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "ios-apple-radius.e2e.ts",
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  timeout: 90_000,
  outputDir: "../../../.local/tmp/card1735/apple-radius-app/results",
  use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:4329" },
  webServer: {
    command: `node "${realpathSync("node_modules/vite/bin/vite.js")}" --host 127.0.0.1 --port 4329 --strictPort`,
    url: "http://127.0.0.1:4329",
    reuseExistingServer: false,
    env: { VITE_API_BASE: "http://127.0.0.1:5200" },
    timeout: 120_000,
  },
});
