import { defineConfig, devices } from "@playwright/test";

/**
 * 결재형 보고 창 화면 시험. 빌드 없이 로컬 개발 서버를 띄우고, 응답은 시험이 page.route로 채운다.
 * 캡처와 조작 결과 파일은 PAS_REPORT_THREAD_SHOTS(기본은 워크트리의 .local/pas-report-thread/)에 쓴다.
 */
export default defineConfig({
  testDir: ".",
  testMatch: "pas-report-thread.e2e.ts",
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  timeout: 120_000,
  outputDir: "./test-results/pas-report-thread",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:4174",
    trace: "retain-on-failure",
    launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] },
  },
  webServer: {
    command: "pnpm exec vite --host 127.0.0.1 --port 4174 --strictPort",
    url: "http://127.0.0.1:4174",
    cwd: "..",
    env: { ...process.env, VITE_API_BASE: "http://127.0.0.1:9" } as Record<string, string>,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
