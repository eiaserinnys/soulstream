import { defineConfig } from "vite";
import { resolve } from "path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// soul-ui/node_modules 경로: pnpm의 구조상 Rollup이 자동으로 탐색하지 않으므로
// soul-ui의 의존성 패키지들을 명시적으로 alias 등록한다.
const soulUiModules = resolve(__dirname, "../packages/soul-ui/node_modules");

export default defineConfig({
  plugins: [tailwindcss(), react()],
  root: ".",
  resolve: {
    alias: {
      "@seosoyoung/soul-ui": resolve(__dirname, "../packages/soul-ui/src"),
      // soul-ui 내부 @shared/* alias: soul-ui 소스를 직접 참조할 때 필요
      "@shared": resolve(__dirname, "../packages/soul-ui/src/shared"),
      "client": resolve(__dirname, "client"),
      // soul-ui의 의존성 패키지들 — soul-ui/node_modules에서 참조
      // pnpm의 node_modules 구조상 Rollup이 packages/soul-ui/node_modules를 자동으로 탐색하지 않음.
      "@base-ui/react": resolve(soulUiModules, "@base-ui/react"),
      "@tanstack/react-virtual": resolve(soulUiModules, "@tanstack/react-virtual"),
      "class-variance-authority": resolve(soulUiModules, "class-variance-authority"),
      "clsx": resolve(soulUiModules, "clsx"),
      "highlight.js": resolve(soulUiModules, "highlight.js"),
      "lucide-react": resolve(soulUiModules, "lucide-react"),
      "radix-ui": resolve(soulUiModules, "radix-ui"),
      "react-day-picker": resolve(soulUiModules, "react-day-picker"),
      "react-markdown": resolve(soulUiModules, "react-markdown"),
      "rehype-highlight": resolve(soulUiModules, "rehype-highlight"),
      "remark-gfm": resolve(soulUiModules, "remark-gfm"),
      "tailwind-merge": resolve(soulUiModules, "tailwind-merge"),
      "zustand": resolve(soulUiModules, "zustand"),
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
