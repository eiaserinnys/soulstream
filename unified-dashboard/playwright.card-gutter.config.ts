import { defineConfig } from "@playwright/test";
import components from "./playwright.components.config";
export default defineConfig({ ...components, testMatch: "card-inheritance.qa.ts",
  outputDir: "../../../.local/artifacts/20261001-web-ui-v3/gutter-results" });
