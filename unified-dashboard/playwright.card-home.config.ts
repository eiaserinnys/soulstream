import {defineConfig} from "@playwright/test";
import {realpathSync} from "node:fs";
export default defineConfig({
 testDir:"./e2e",testMatch:"card-home.e2e.ts",workers:1,retries:0,timeout:60000,reporter:"list",
 outputDir:"../../../.local/artifacts/20261002-card-home-web/results",
 use:{baseURL:"http://127.0.0.1:4193",trace:"retain-on-failure"},
 webServer:{command:`node "${realpathSync("node_modules/vite/bin/vite.js")}" preview --host 127.0.0.1 --port 4193 --strictPort`,url:"http://127.0.0.1:4193",env:{VITE_API_BASE:"http://127.0.0.1:5200"},reuseExistingServer:false,timeout:60000},
});
