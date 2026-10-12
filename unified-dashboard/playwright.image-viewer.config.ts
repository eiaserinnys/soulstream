import { defineConfig } from "@playwright/test";
import { realpathSync } from "node:fs";
export default defineConfig({
  testDir:"./e2e", testMatch:"image-viewer.e2e.ts", workers:1, retries:0,
  timeout:60_000, reporter:[["list"]],
  outputDir:"../../../.local/artifacts/20261012-image-viewer/results",
  use:{baseURL:"http://127.0.0.1:4314", actionTimeout:5000},
  webServer:{
    command:`node "${realpathSync("node_modules/vite/bin/vite.js")}" --host 127.0.0.1 --port 4314 --strictPort`,
    url:"http://127.0.0.1:4314",reuseExistingServer:false,timeout:60_000,
    env:{VITE_API_BASE:"http://127.0.0.1:5200"},
  },
});
