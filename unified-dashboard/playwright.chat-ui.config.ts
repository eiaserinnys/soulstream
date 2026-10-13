import { defineConfig } from "@playwright/test";
import smoke from "./playwright.smoke.config";
export default defineConfig({ ...smoke, testMatch: ["chat-ui.e2e.ts", "smoke.e2e.ts", "components-review.e2e.ts"],
  timeout: 60_000, retries: 0, outputDir: "../../../.local/artifacts/pas-web-w4/results",
  use: { ...smoke.use, viewport: { width: 1440, height: 1000 }, permissions: ["clipboard-read", "clipboard-write"] },
  webServer: { ...smoke.webServer, reuseExistingServer: false, env: { VITE_API_BASE: "http://127.0.0.1:9" } } });
