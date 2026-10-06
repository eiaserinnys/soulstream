import { defineConfig } from "@playwright/test";
import components from "./playwright.components.config";

export default defineConfig({
  ...components,
  testMatch: "pas-ui2-turn-end.e2e.ts",
  outputDir: "../../../.local/artifacts/pas-ui2-turn-end/results",
});
