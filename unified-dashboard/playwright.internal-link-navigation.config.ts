import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: ["internal-link-navigation.e2e.ts", "session-search-intent.e2e.ts"],
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  outputDir: "../.local/artifacts/20261012-internal-link-web/results",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:4323",
    serviceWorkers: "block",
    reducedMotion: "reduce",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "corepack pnpm@10.32.1 exec vite preview --host 127.0.0.1 --port 4323 --strictPort",
    url: "http://127.0.0.1:4323",
    reuseExistingServer: false,
    timeout: 60_000,
    env: { VITE_API_BASE: "http://127.0.0.1:5200" },
  },
});
