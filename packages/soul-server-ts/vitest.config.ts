import { defineConfig } from "vitest/config";

// soul-ui/vitest.config.ts 패턴 기반 (environment: node, include *.test.ts).
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 10000,
    hookTimeout: 10000,
  },
});
