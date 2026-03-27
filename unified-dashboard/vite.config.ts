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
      "client/store": resolve(__dirname, "client/store"),
      // soul-ui 소스를 직접 alias로 참조할 때 soul-ui의 peer/deps를 찾을 수 있도록 명시적 alias 추가.
      // pnpm의 node_modules 구조상 Rollup이 packages/soul-ui/node_modules를 자동으로 탐색하지 않음.
      "@base-ui/react": resolve(__dirname, "../packages/soul-ui/node_modules/@base-ui/react"),
      // @xyflow/react: soul-ui 내 NodeGraph 컴포넌트 빌드 시 필요
      "@xyflow/react": resolve(__dirname, "../packages/soul-ui/node_modules/@xyflow/react"),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    // 개발 시 soul-server(single-node) 또는 soulstream-server(orchestrator)로 API 프록시
    // VITE_API_BASE=http://localhost:3105  (soul-server, single-node)
    // VITE_API_BASE=http://localhost:5200  (soulstream-server, orchestrator)
    proxy: {
      "/api": {
        target: process.env.VITE_API_BASE ?? "http://localhost:3105",
        changeOrigin: true,
      },
      "/cogito": {
        target: process.env.VITE_API_BASE ?? "http://localhost:3105",
        changeOrigin: true,
      },
    },
  },
});
