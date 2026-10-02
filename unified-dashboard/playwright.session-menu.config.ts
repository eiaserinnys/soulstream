import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir:"./e2e",testMatch:"session-menu-unification.e2e.ts",workers:1,
  timeout:60000,reporter:"list",
  outputDir:"./e2e/test-results/session-menu",
  use:{baseURL:"http://127.0.0.1:4181",serviceWorkers:"block",reducedMotion:"reduce",screenshot:"only-on-failure",trace:"retain-on-failure"},
  webServer:{command:"corepack pnpm@10.32.1 exec vite preview --host 127.0.0.1 --port 4181 --strictPort",
    url:"http://127.0.0.1:4181",reuseExistingServer:false,timeout:60000,
    env:{VITE_API_BASE:"http://127.0.0.1:5200"}},
});
