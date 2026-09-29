import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  timeout: 60_000,
  outputDir: "./e2e/test-results/folder-regression",
  use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:4173", actionTimeout: 10_000, screenshot: "only-on-failure", trace: "off" },
  webServer: {
    command: "pnpm exec vite preview --host 127.0.0.1 --port 4173 --strictPort",
    url: "http://127.0.0.1:4173",
    env: { ...process.env, VITE_API_BASE: "http://127.0.0.1:5200" },
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
