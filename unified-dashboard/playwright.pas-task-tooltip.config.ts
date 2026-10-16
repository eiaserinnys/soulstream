import { defineConfig } from "@playwright/test";
import components from "./playwright.components.config";

export default defineConfig({
  ...components,
  testMatch: "pas-task-tooltip.e2e.ts",
  workers: 1,
  retries: 0,
  timeout: 90_000,
  outputDir: "../../../.local/artifacts/20261014-366-tooltip-impl/results",
});
