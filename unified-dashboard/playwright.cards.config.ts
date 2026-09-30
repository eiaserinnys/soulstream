import { defineConfig, devices } from "@playwright/test";
import path from "node:path";
export default defineConfig({
 testDir:"./e2e",testMatch:"cards-p1-web.e2e.ts",workers:1,retries:0,timeout:60000,reporter:[["list"]],
 outputDir:path.join(process.env.CARD_WEB_OUTPUT??"./e2e/test-results/cards-p1-web","playwright-results"),
 use:{...devices["Desktop Chrome"],baseURL:"http://127.0.0.1:4179",trace:"retain-on-failure"},
 webServer:{command:"pnpm exec vite preview --host 127.0.0.1 --port 4179 --strictPort",url:"http://127.0.0.1:4179",env:{...process.env,VITE_API_BASE:"http://127.0.0.1:5200"},reuseExistingServer:false,timeout:60000}
});
