import { defineConfig } from "vite";
import { resolve } from "path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [tailwindcss(), react()],
  root: ".",
  resolve: {
    alias: {
      "@shared": resolve(__dirname, "../packages/soul-ui/src/shared"),
      "@seosoyoung/soul-ui": resolve(__dirname, "../packages/soul-ui/src"),
      "client/lib": resolve(__dirname, "client/lib"),
      "client/hooks": resolve(__dirname, "client/hooks"),
      "client/components": resolve(__dirname, "client/components"),
      // soul-ui 소스를 직접 alias로 참조할 때 soul-ui의 peer/deps를 찾을 수 있도록 명시적 alias 추가.
      // pnpm의 node_modules 구조상 Rollup이 packages/soul-ui/node_modules를 자동으로 탐색하지 않음.
      "@base-ui/react": resolve(__dirname, "../packages/soul-ui/node_modules/@base-ui/react"),
      "@xyflow/react": resolve(__dirname, "node_modules/@xyflow/react"),
    },
  },
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
  },
  server: {
    // 개발 시 대시보드 서버로 API 프록시
    proxy: {
      "/api": {
        target: "http://localhost:3109",
        changeOrigin: true,
      },
    },
  },
  test: {
    globals: true,
    environment: "node",
    include: [
      "client/**/*.test.ts",
      "server/**/*.test.ts",
      "tests/**/*.test.ts",
      "../packages/soul-ui/src/**/*.test.ts",
    ],
    alias: {
      "@shared": resolve(__dirname, "../packages/soul-ui/src/shared"),
      "@seosoyoung/soul-ui": resolve(__dirname, "../packages/soul-ui/src"),
    },
    server: {
      deps: {
        external: [
          "express",
          "cors",
          "eventsource",
        ],
        moduleDirectories: [
          resolve(__dirname, "node_modules"),
          "node_modules",
        ],
      },
    },
  },
});
