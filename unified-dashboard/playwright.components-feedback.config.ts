import { defineConfig } from "@playwright/test";
import { realpathSync } from "node:fs";
import components from "./playwright.components.config";

export default defineConfig({ ...components, testMatch: "components-feedback.e2e.ts",
  outputDir: "../../../.local/artifacts/20261001-components-feedback/results",
  ...(process.env.COMPONENTS_REVIEW_BUILD === "1" ? { webServer: {
    command: `node "${realpathSync("node_modules/vite/bin/vite.js")}" preview --host 127.0.0.1 --port 4198 --strictPort`,
    url: "http://127.0.0.1:4198", env: { VITE_API_BASE: "http://127.0.0.1:5200" }, reuseExistingServer: false, timeout: 60_000,
  } } : {}),
});
