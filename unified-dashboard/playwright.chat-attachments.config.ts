import { defineConfig, devices } from "@playwright/test";
import { realpathSync } from "node:fs";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "chat-attachments.e2e.ts",
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: [["list"]],
  outputDir: "../../../.local/artifacts/20261017-b2-16-attachment-chat/results",
  use: {
    ...devices["Desktop Chrome"],
    acceptDownloads: true,
    baseURL: "http://127.0.0.1:4199",
  },
  webServer: {
    command: "node \"" + realpathSync("node_modules/vite/bin/vite.js") + "\" --host 127.0.0.1 --port 4199 --strictPort",
    url: "http://127.0.0.1:4199",
    reuseExistingServer: false,
    env: { VITE_API_BASE: "http://127.0.0.1:5200" },
    timeout: 60_000,
  },
});
