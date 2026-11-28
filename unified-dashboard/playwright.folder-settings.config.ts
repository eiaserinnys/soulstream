import { defineConfig, devices } from "@playwright/test";
import { realpathSync } from "node:fs";

const port = Number(process.env.FOLDER_SETTINGS_PORT ?? 4381);

export default defineConfig({
  testDir: "./e2e",
  testMatch: "folder-settings-visual.e2e.ts",
  workers: 1,
  retries: 0,
  timeout: 240_000,
  reporter: [["list"]],
  outputDir: `${process.env.FOLDER_SETTINGS_OUT ?? "test-results"}/playwright-results`,
  use: { ...devices["Desktop Chrome"], baseURL: `http://127.0.0.1:${port}`, actionTimeout: 10_000, screenshot: "only-on-failure" },
  webServer: {
    command: `node "${realpathSync("node_modules/vite/bin/vite.js")}" --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: true,
    env: { VITE_API_BASE: "http://127.0.0.1:5299" },
    timeout: 180_000,
  },
});
