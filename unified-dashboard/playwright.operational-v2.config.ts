import { defineConfig } from "@playwright/test";
import components from "./playwright.components.config";
export default defineConfig({...components,testMatch:"operational-feedback-v2.e2e.ts",outputDir:"../../../.local/artifacts/20261001-web-ui-v2/operational-results"});
