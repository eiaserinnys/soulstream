import { defineConfig } from "@playwright/test";
import components from "./playwright.components.config";

export default defineConfig({
  ...components,
  testMatch: "pas-ui2-buttons.e2e.ts",
  outputDir: "../../../.local/artifacts/pas-ui2-buttons-web/results",
});
