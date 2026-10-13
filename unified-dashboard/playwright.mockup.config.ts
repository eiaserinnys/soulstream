import { defineConfig, devices } from "@playwright/test";
import { realpathSync } from "node:fs";

// 시안 묶음이 운영 빌드와 같은 모습인지 견준다.
// 먼저 두 빌드를 만든다: `vite build` 와 `MOCKUP=proof-343 vite build --config vite.mockup.config.ts`.
const vite = realpathSync("node_modules/vite/bin/vite.js");
export default defineConfig({
  testDir: "./e2e",
  testMatch: "mockup-parity.qa.ts",
  workers: 1,
  retries: 0,
  timeout: 180_000,
  reporter: [["list"]],
  outputDir: process.env.MOCKUP_PARITY_OUTPUT ? `${process.env.MOCKUP_PARITY_OUTPUT}/results` : "test-results/mockup-parity",
  use: { ...devices["Desktop Chrome"] },
  webServer: [
    {
      command: `node "${vite}" preview --host 127.0.0.1 --port 4391 --strictPort`,
      url: "http://127.0.0.1:4391", reuseExistingServer: false, timeout: 60_000,
      env: { VITE_API_BASE: "http://127.0.0.1:9" },
    },
    {
      // 발행 주소처럼 하위 경로(/proof-343/)에서 연다.
      command: "python3 -m http.server 4392 --bind 127.0.0.1 --directory dist-mockups",
      url: "http://127.0.0.1:4392/proof-343/frame.html", reuseExistingServer: false, timeout: 30_000,
    },
  ],
});
