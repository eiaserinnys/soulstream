import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dashboardRoot = fileURLToPath(new URL(".", import.meta.url));
const evidenceRoot = resolve(dashboardRoot, "../../../.local/artifacts/main-grid-css-185");
const previewUrl = "http://127.0.0.1:4173";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "v3-main-grid-css-185.e2e.ts",
  outputDir: resolve(evidenceRoot, "web-e2e-results"),
  workers: 1,
  retries: 0,
  timeout: 30_000,
  globalTimeout: 120_000,
  reporter: "list",
  use: {
    baseURL: previewUrl,
    serviceWorkers: "block",
    trace: "off",
    screenshot: "off",
  },
  webServer: {
    command: "node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4173 --strictPort",
    url: previewUrl,
    env: { ...process.env, VITE_API_BASE: "http://127.0.0.1:5200" },
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
