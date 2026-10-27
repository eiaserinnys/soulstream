import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e/readme-demo",
  testMatch: "readme-demo.capture.ts",
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  timeout: 120_000,
  expect: { timeout: 30_000 },
  outputDir: "./e2e/test-results/readme-demo",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:4174",
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    serviceWorkers: "block",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "pnpm exec vite --host 127.0.0.1 --port 4174 --strictPort",
    url: "http://127.0.0.1:4174",
    env: {
      ...process.env,
      VITE_API_BASE: "http://127.0.0.1:5200",
    },
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
