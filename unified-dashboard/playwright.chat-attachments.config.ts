import { defineConfig, devices } from "@playwright/test";

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
    command: "node e2e/chat-attachments-download-server.mjs",
    url: "http://127.0.0.1:4199",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
