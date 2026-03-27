import { defineConfig } from "vite";
import { resolve } from "path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const soulUiModules = resolve(__dirname, "../packages/soul-ui/node_modules");

export default defineConfig({
  plugins: [tailwindcss(), react()],
  root: ".",
  resolve: {
    alias: {
      "@seosoyoung/soul-ui": resolve(__dirname, "../packages/soul-ui/src"),
      "@shared": resolve(__dirname, "../packages/soul-ui/src/shared"),
      "client": resolve(__dirname, "client"),
      // soul-ui 소스를 직접 alias로 참조할 때 soul-ui의 peer/deps를 찾을 수 있도록 명시적 alias 추가.
      // pnpm의 node_modules 구조상 Rollup이 packages/soul-ui/node_modules를 자동으로 탐색하지 않음.
      // 주의: 내부에서 sub-path 재수출(export * from 'pkg/sub')을 사용하는 패키지(zustand 등)는
      // 디렉토리 alias 시 CJS fallback으로 named export가 사라지므로 alias하지 않는다.
      "@base-ui/react": resolve(soulUiModules, "@base-ui/react"),
      "@xyflow/react": resolve(soulUiModules, "@xyflow/react"),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5202,
    proxy: {
      "/api": {
        target: "http://localhost:5200",
        changeOrigin: true,
      },
    },
  },
});
