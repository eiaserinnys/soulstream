import { defineConfig } from "@playwright/test";
import components from "./playwright.components.config";

/**
 * 예약 작업 편집기(설정 모달 · 반복 작업 탭)의 입력 칸 배치·일정 컨트롤 측정 구성.
 * 서버 API는 e2e/recurring-jobs-*.e2e.ts가 page.route로 흉내 내므로
 * components 구성의 dev 서버를 그대로 쓰고 실행 파일만 좁힌다.
 * (recurring-jobs-layout: 칸 배치·초점 고리, recurring-jobs-controls: 일정 컨트롤 표면)
 */
export default defineConfig({
  ...components,
  testMatch: "recurring-jobs-*.e2e.ts",
  outputDir: "../../../.local/artifacts/card1456-recurring-jobs-layout/results",
  use: { ...components.use, serviceWorkers: "block" },
});
