import { defineConfig } from "@playwright/test";
import components from "./playwright.components.config";

export default defineConfig({ ...components, testMatch: "persistent-defaults.e2e.ts", outputDir: "../../../.local/tmp/card1836/pas-defaults-web/playwright-results" });
