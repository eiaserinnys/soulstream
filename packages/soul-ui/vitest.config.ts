import { defineConfig } from "vitest/config";
import path from "path";
import { fileURLToPath } from "url";

// 운영 호스트의 NODE_ENV=production을 테스트 워커에 물려주면 React의
// production 빌드가 선택되어 act() 기반 컴포넌트 테스트가 동작하지 않는다.
process.env.NODE_ENV = "test";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// packages/soul-ui/vitest.config.ts → 2단계 상위 = soulstream 루트
const PROJECT_ROOT = path.resolve(__dirname, "../..");

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: [
      `${PROJECT_ROOT}/packages/soul-ui/src/**/*.test.ts`,
      `${PROJECT_ROOT}/packages/soul-ui/src/**/*.test.tsx`,
    ],
    alias: {
      "@shared": `${PROJECT_ROOT}/packages/soul-ui/src/shared`,
      "@seosoyoung/soul-ui": `${PROJECT_ROOT}/packages/soul-ui/src`,
      "zod": `${PROJECT_ROOT}/packages/soul-ui/node_modules/zod`,
    },
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
