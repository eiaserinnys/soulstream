import { defineConfig } from "vite";
import { resolve } from "path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [tailwindcss(), react()],
  root: ".",
  resolve: {
    alias: {
      "@seosoyoung/soul-ui": resolve(__dirname, "../packages/soul-ui/src"),
      // soul-ui 내부 @shared/* alias: soul-ui 소스를 직접 참조할 때 필요
      "@shared": resolve(__dirname, "../packages/soul-ui/src/shared"),
      "client": resolve(__dirname, "client"),
      // soul-ui 소스를 직접 alias로 참조할 때 soul-ui의 peer/deps를 찾을 수 있도록 명시적 alias 추가.
      // pnpm의 node_modules 구조상 Rollup이 packages/soul-ui/node_modules를 자동으로 탐색하지 않음.
      "@base-ui/react": resolve(__dirname, "../packages/soul-ui/node_modules/@base-ui/react"),
      // @xyflow/react는 soul-dashboard 의존성이므로 soul-dashboard/node_modules에서 참조
      "@xyflow/react": resolve(__dirname, "../soul-dashboard/node_modules/@xyflow/react"),
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
