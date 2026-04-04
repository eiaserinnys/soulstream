import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  timeout: 60_000,
  use: {
    headless: true,
    baseURL: "http://localhost:5200",
    viewport: { width: 1280, height: 800 },
  },
  reporter: [["list"]],
  // TypeScript 파일을 CommonJS로 변환
  // @ts-ignore
  build: {
    external: [],
  },
});
