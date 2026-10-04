import { defineConfig } from "@playwright/test";
import { realpathSync } from "node:fs";

export default defineConfig({
  testDir: "./e2e", testMatch: "folder-session-autoload.e2e.ts",
  workers: 1, retries: 0, timeout: 60_000, reporter: "list",
  outputDir: "./e2e/test-results/folder-session-autoload",
  use: { baseURL: "http://127.0.0.1:4227", serviceWorkers: "block", trace: "retain-on-failure" },
  webServer: {
    command: `node "${realpathSync("node_modules/vite/bin/vite.js")}" --host 127.0.0.1 --port 4227 --strictPort`,
    url: "http://127.0.0.1:4227", reuseExistingServer: false, timeout: 60_000,
    env: { VITE_API_BASE: "http://127.0.0.1:5200" },
  },
});
