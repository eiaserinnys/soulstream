import { defineConfig } from "@playwright/test";
import { realpathSync } from "node:fs";
const baseline = Boolean(process.env.TODAY_BASELINE);
export default defineConfig({
 testDir: "./e2e", testMatch: baseline ? "today-screen-design.e2e.ts" : ["today-screen-design.e2e.ts", "cards-p1-web.e2e.ts"],
 workers: 1, fullyParallel: false, retries: 0, timeout: 60000, reporter: "list",
 use: { baseURL: "http://127.0.0.1:4197", trace: "retain-on-failure" },
 webServer: { command: `node ${realpathSync("node_modules/vite/bin/vite.js")} ${baseline ? "" : "preview"} --host 127.0.0.1 --port 4197 --strictPort`, url: "http://127.0.0.1:4197", reuseExistingServer: false, env: { VITE_API_BASE: "http://127.0.0.1:5200" } },
});
