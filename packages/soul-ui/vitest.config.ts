import { defineConfig } from "vitest/config";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// packages/soul-ui/vitest.config.ts → 2단계 상위 = soulstream 루트
const PROJECT_ROOT = path.resolve(__dirname, "../..");

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: [`${PROJECT_ROOT}/packages/soul-ui/src/**/*.test.ts`],
    alias: {
      "@shared": `${PROJECT_ROOT}/packages/soul-ui/src/shared`,
      "@seosoyoung/soul-ui": `${PROJECT_ROOT}/packages/soul-ui/src`,
    },
    server: {
      deps: {
        moduleDirectories: [
          `${PROJECT_ROOT}/unified-dashboard/node_modules`,
          `${PROJECT_ROOT}/packages/soul-ui/node_modules`,
          "node_modules",
        ],
        inline: [/zustand/],
      },
    },
  },
});
