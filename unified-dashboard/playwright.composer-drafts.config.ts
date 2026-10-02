import {defineConfig,devices} from "@playwright/test";
import {realpathSync} from "node:fs";
export default defineConfig({
 testDir:"./e2e",testMatch:"composer-drafts.qa.ts",outputDir:`${process.env.COMPOSER_DRAFT_EVIDENCE_DIR}/playwright-results`,workers:1,retries:0,timeout:60000,reporter:[["list"]],
 use:{...devices["Desktop Chrome"],baseURL:"http://127.0.0.1:4208",trace:"retain-on-failure"},
 webServer:{command:`node "${realpathSync("node_modules/vite/bin/vite.js")}" preview --host 127.0.0.1 --port 4208 --strictPort`,url:"http://127.0.0.1:4208",env:{VITE_API_BASE:"http://127.0.0.1:5200"},reuseExistingServer:false,timeout:60000},
});
