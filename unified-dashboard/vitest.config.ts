import { defineConfig } from "vitest/config";

// vite.config.ts는 PWA plugin과 React/Tailwind plugin을 포함한다.
// 테스트는 isTauri 같은 순수 함수만 검증하므로 PWA·React plugin이 불필요하고,
// inherit 시 빌드 사이드 이펙트가 테스트 시작에 영향을 줄 수 있다.
// 본 config는 vite.config와 분리하여 minimal하게 유지한다(design-principles §1·§3).
export default defineConfig({
  test: {
    include: ["client/**/*.test.ts"],
    environment: "node",
  },
});
