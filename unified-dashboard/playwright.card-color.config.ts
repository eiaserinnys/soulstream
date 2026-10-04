import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "card-color-web.e2e.ts",
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  reporter: "list",
  outputDir: "../../../.local/artifacts/20261005-card-color-web/results",
  use: { baseURL: "http://127.0.0.1:4187", headless: true, screenshot: "only-on-failure" },
  webServer: {
    command: "node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 4187 --strictPort",
    env: { VITE_API_BASE: "http://127.0.0.1:5200" },
    url: "http://127.0.0.1:4187",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
