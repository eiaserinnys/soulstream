import { defineConfig } from "@playwright/test";
import components from "./playwright.components.config";

export default defineConfig({
  ...components,
  testMatch: "pas-ui2-card-overlay.e2e.ts",
  outputDir: "../../../.local/artifacts/20261007-w6-pas-card-overlay-web/results",
});
