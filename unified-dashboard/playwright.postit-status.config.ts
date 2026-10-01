import { defineConfig } from "@playwright/test";
import {realpathSync} from "node:fs";
export default defineConfig({
 testDir:"./e2e",testMatch:"postit-scale-status.e2e.ts",workers:1,fullyParallel:false,timeout:60000,reporter:"list",
 outputDir:"../../../.local/artifacts/20261001-postit-scale-status/results",
 use:{baseURL:"http://127.0.0.1:4188",headless:true,screenshot:"only-on-failure"},
 webServer:{command:`node "${realpathSync('node_modules/vite/bin/vite.js')}" --host 127.0.0.1 --port 4188 --strictPort`,
 env:{VITE_API_BASE:"http://127.0.0.1:5200"},url:"http://127.0.0.1:4188",reuseExistingServer:false,timeout:60000},
});
