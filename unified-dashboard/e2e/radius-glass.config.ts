import { defineConfig, devices } from "@playwright/test";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dashDir = fileURLToPath(new URL("..", import.meta.url));
const viteBin = realpathSync(new URL("../node_modules/vite/bin/vite.js", import.meta.url));

export default defineConfig({
  testDir: ".",
  testMatch: "radius-glass-review.e2e.ts",
  workers: 1,
  retries: 0,
  timeout: 180_000,
  reporter: [["list"]],
  outputDir: "../../.local/artifacts/20261120-radius-glass-review/results",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:4199",
    launchOptions: {
      args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
    },
  },
  webServer: {
    command: `node "${viteBin}" --host 127.0.0.1 --port 4199 --strictPort`,
    cwd: dashDir,
    url: "http://127.0.0.1:4199",
    reuseExistingServer: false,
    env: { VITE_API_BASE: "http://127.0.0.1:5200" },
    timeout: 90_000,
  },
});
