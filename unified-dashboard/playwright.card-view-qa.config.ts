import { defineConfig, devices } from "@playwright/test";
import { realpathSync } from "node:fs";

export default defineConfig({
  testDir: "./e2e", testMatch: "card-view-qa.e2e.ts", workers: 1, retries: 0,
  timeout: 60000, reporter: "list", outputDir: "../../../.local/artifacts/20261004-web-card-view-qa/results",
  use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:45312", actionTimeout: 5000 },
  webServer: {
    command: `node "${realpathSync("node_modules/vite/bin/vite.js")}" --host 127.0.0.1 --port 45312 --strictPort`,
    url: "http://127.0.0.1:45312", reuseExistingServer: false, timeout: 60000,
    env: { VITE_API_BASE: "http://127.0.0.1:5200" },
  },
});
