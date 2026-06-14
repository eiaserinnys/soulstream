import { defineConfig } from "vite";
import { resolve } from "path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    tailwindcss(),
    react(),
    VitePWA({
      registerType: "autoUpdate",
      workbox: {
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api/, /^\/cogito/],
        // API/SSE fetch 요청을 Service Worker 캐시에서 완전 제외.
        // navigateFallbackDenylist는 navigate 요청에만 적용되므로,
        // runtimeCaching을 비워서 fetch 요청도 캐시하지 않게 한다.
        runtimeCaching: [],
      },
      manifest: {
        name: "Soulstream",
        short_name: "Soulstream",
        description: "Claude Code session hosting dashboard",
        start_url: "/",
        theme_color: "#000000",
        background_color: "#000000",
        display: "standalone",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
        ],
      },
    }),
  ],
  root: ".",
  resolve: {
    dedupe: ["react", "react-dom"],
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
      // @dnd-kit: soul-ui DashboardDndProvider/FolderTree에서 사용
      "@dnd-kit/core": resolve(__dirname, "../packages/soul-ui/node_modules/@dnd-kit/core"),
      "@dnd-kit/sortable": resolve(__dirname, "../packages/soul-ui/node_modules/@dnd-kit/sortable"),
      "@dnd-kit/utilities": resolve(__dirname, "../packages/soul-ui/node_modules/@dnd-kit/utilities"),
      // zod: soul-ui FolderDialog/FolderSettingsDialog에서 사용 (@hookform/resolvers 포함)
      // pnpm 모듈 해석 경로 불일치로 zod/v4/core를 못 찾는 문제 해결
      "zod": resolve(__dirname, "../packages/soul-ui/node_modules/zod"),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 725,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("/packages/soul-ui/src/components/MarkdownCodeMirrorEditor.tsx")) {
            return "markdown-editor";
          }
          if (id.includes("/packages/soul-ui/src/")) {
            return "soul-ui";
          }
          if (!id.includes("/node_modules/")) {
            return undefined;
          }
          if (
            id.includes("/@codemirror/") ||
            id.includes("/@lezer/") ||
            id.includes("/y-codemirror.next/") ||
            id.includes("/crelt/") ||
            id.includes("/style-mod/") ||
            id.includes("/w3c-keyname/")
          ) {
            return "vendor-markdown-editor";
          }
          if (id.includes("/@tanstack/")) {
            return "vendor-tanstack";
          }
          if (id.includes("/@dnd-kit/")) {
            return "vendor-dnd";
          }
          if (
            id.includes("/@base-ui/") ||
            id.includes("/radix-ui/") ||
            id.includes("/@floating-ui/")
          ) {
            return "vendor-ui";
          }
          if (id.includes("/lucide-react/") || id.includes("/lucide/")) {
            return "vendor-icons";
          }
          if (id.includes("/react-dom/")) {
            return "vendor-react-dom";
          }
          if (id.includes("/react/") || id.includes("/scheduler/")) {
            return "vendor-react";
          }
          return "vendor";
        },
      },
    },
  },
  server: {
    // 개발 시 soul-server(single-node) 또는 soulstream-server(orchestrator)로 API 프록시
    // VITE_API_BASE=http://localhost:3105  (soul-server, single-node)
    // VITE_API_BASE=http://localhost:5200  (soulstream-server, orchestrator)
    proxy: {
      "/api": {
        target: process.env.VITE_API_BASE,
        changeOrigin: true,
      },
      "/cogito": {
        target: process.env.VITE_API_BASE,
        changeOrigin: true,
      },
    },
  },
});
