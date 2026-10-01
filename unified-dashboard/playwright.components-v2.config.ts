import { defineConfig } from "@playwright/test";
import components from "./playwright.components.config";
export default defineConfig({ ...components, testMatch: ["components-feedback-v2.e2e.ts", "operational-feedback-v2.e2e.ts"], outputDir: "../../../.local/artifacts/20261001-web-ui-v2/results" });
