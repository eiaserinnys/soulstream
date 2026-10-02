import { defineConfig, devices } from "@playwright/test";
import { realpathSync } from "node:fs";
export default defineConfig({
 testDir:"./e2e",testMatch:"card-tabs.qa.ts",workers:1,retries:0,timeout:60000,reporter:[["list"]],
 use:{...devices["Desktop Chrome"],baseURL:"http://127.0.0.1:4199",trace:"off"},
 webServer:{command:`node "${realpathSync("node_modules/vite/bin/vite.js")}" preview --host 127.0.0.1 --port 4199 --strictPort`,url:"http://127.0.0.1:4199",env:{VITE_API_BASE:"http://127.0.0.1:5200"},reuseExistingServer:false,timeout:60000},
});
