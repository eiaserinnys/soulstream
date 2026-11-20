import { defineConfig, devices } from "@playwright/test";
import { realpathSync } from "node:fs";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  timeout: 60_000,
  outputDir: "./e2e/test-results",
  use: {
    trace: "off",
    screenshot: "only-on-failure",
    baseURL: "http://127.0.0.1:4318",
  },
  webServer: {
    command: `node "${realpathSync("node_modules/vite/bin/vite.js")}" --host 127.0.0.1 --port 4318 --strictPort`,
    url: "http://127.0.0.1:4318",
    reuseExistingServer: false,
    env: { VITE_API_BASE: "http://127.0.0.1:5200" },
    timeout: 120_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
