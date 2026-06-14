import { defineConfig } from "vitest/config";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// unified-dashboard/vitest.config.ts -> 1단계 상위 = soulstream 루트
const PROJECT_ROOT = path.resolve(__dirname, "..");
const soulUiAliases = {
  "@shared": `${PROJECT_ROOT}/packages/soul-ui/src/shared`,
  "@seosoyoung/soul-ui": `${PROJECT_ROOT}/packages/soul-ui/src`,
  zod: `${PROJECT_ROOT}/packages/soul-ui/node_modules/zod`,
};

// vite.config.ts는 PWA plugin과 React/Tailwind plugin을 포함한다.
// 테스트는 isTauri 같은 순수 함수만 검증하므로 PWA·React plugin이 불필요하고,
// inherit 시 빌드 사이드 이펙트가 테스트 시작에 영향을 줄 수 있다.
// 본 config는 vite.config와 분리하여 minimal하게 유지한다(design-principles §1·§3).
export default defineConfig({
  resolve: {
    alias: soulUiAliases,
  },
  test: {
    include: ["client/**/*.test.ts"],
    environment: "node",
    alias: soulUiAliases,
    server: {
      deps: {
        moduleDirectories: [
          `${PROJECT_ROOT}/unified-dashboard/node_modules`,
          `${PROJECT_ROOT}/packages/soul-ui/node_modules`,
          "node_modules",
        ],
        inline: [/zustand/, /@hookform\/resolvers/, /zod/],
      },
    },
  },
});
