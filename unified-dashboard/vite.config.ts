import { defineConfig, loadEnv, type ConfigEnv } from "vite";
import { resolve } from "path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

import { DASHBOARD_PWA_OPTIONS } from "./pwa-config";
import { version as dashboardVersion } from "./package.json";

function requireDevProxyApiBase(env: Record<string, string | undefined>): string {
  const apiBase = env.VITE_API_BASE?.trim();
  if (!apiBase) {
    throw new Error(
      [
        "unified-dashboard dev server requires VITE_API_BASE.",
        "Set VITE_API_BASE=http://localhost:5200 for the orchestrator.",
      ].join(" "),
    );
  }
  return apiBase;
}

export default defineConfig(({ command, mode }: ConfigEnv) => {
  const env = { ...loadEnv(mode, __dirname, ""), ...process.env };
  const devProxyTarget = command === "serve" ? requireDevProxyApiBase(env) : undefined;

  return {
    define: {
      // 사용 로그의 appVersion 정본. 별도 env 를 새로 만들지 않고
      // 이미 있는 패키지 버전을 빌드 타임에 박는다.
      __DASHBOARD_VERSION__: JSON.stringify(dashboardVersion),
    },
    plugins: [
      tailwindcss(),
      react(),
      VitePWA(DASHBOARD_PWA_OPTIONS),
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
        // @dnd-kit: soul-ui DashboardDndProvider에서 사용
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
      // 개발 시 orchestrator로 API를 프록시한다.
      proxy: devProxyTarget
        ? {
            "/api": {
              target: devProxyTarget,
              changeOrigin: true,
            },
            "/cogito": {
              target: devProxyTarget,
              changeOrigin: true,
            },
          }
        : {},
    },
  };
});
