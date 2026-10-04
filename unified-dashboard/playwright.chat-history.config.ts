import { defineConfig, devices } from "@playwright/test";
import { realpathSync } from "node:fs";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "chat-history.e2e.ts",
  outputDir: "../.local/chat-history/results",
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 5_000 },
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    viewport: { width: 1440, height: 900 },
    baseURL: "http://127.0.0.1:43179",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: `node "${realpathSync("node_modules/vite/bin/vite.js")}" --host 127.0.0.1 --port 43179 --strictPort`,
    url: "http://127.0.0.1:43179",
    env: { VITE_API_BASE: "http://127.0.0.1:5200" },
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
