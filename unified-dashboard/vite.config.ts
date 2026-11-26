import { defineConfig, loadEnv, type ConfigEnv, type Plugin } from "vite";
import { resolve } from "path";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

import { DASHBOARD_PWA_OPTIONS } from "./pwa-config";
import { version as dashboardVersion } from "./package.json";
import {dashboardBuildIdentity,dashboardBuildManifest} from "./build-identity";
import { handleRollupWarning } from "./rollup-warning";

// Node 22의 fs 재귀 복사는 Windows에서 경로에 한글 같은 비ASCII 글자가 있으면
// 네이티브 경로 검사에서 프로세스째 죽는다(0xC0000409, nodejs/node #54476). 그래서 손으로 복사한다.
function copyTree(source: string, target: string): void {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = resolve(source, entry.name);
    const to = resolve(target, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else copyFileSync(from, to);
  }
}

/** 로고는 JS 그래프와 서비스 워커 밖의 정적 자산으로만 제공한다. */
function brandIcons(): Plugin {
  const root = resolve(__dirname, "node_modules/simple-icons");
  const index = () => JSON.stringify((JSON.parse(readFileSync(resolve(root, "data/simple-icons.json"), "utf8")) as { slug: string; title: string; hex: string }[]).map(({ slug, title, hex }) => ({ slug, title, hex })));
  return {
    name: "brand-icons",
    configureServer(server) {
      server.middlewares.use("/brand-icons", (req, res, next) => {
        if (req.url === "/index.json") { res.setHeader("Content-Type", "application/json"); res.end(index()); return; }
        const match = /^\/icons\/([a-z0-9_-]+\.svg)$/.exec(req.url ?? "");
        if (!match) return next();
        try { res.setHeader("Content-Type", "image/svg+xml"); res.end(readFileSync(resolve(root, "icons", match[1]))); } catch { next(); }
      });
    },
    writeBundle(options) {
      const destination = resolve(options.dir ?? resolve(__dirname, "dist"), "brand-icons");
      mkdirSync(destination, { recursive: true });
      copyTree(resolve(root, "icons"), resolve(destination, "icons"));
      writeFileSync(resolve(destination, "index.json"), index());
    },
  };
}

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

export default defineConfig(({ command, mode, isPreview }: ConfigEnv) => {
  const env = { ...loadEnv(mode, __dirname, ""), ...process.env };
  // 개발 서버(serve이고 preview가 아님)만 VITE_API_BASE를 요구한다. preview는
  // 정적 미리보기라 값이 없어도 뜨고, 값이 있으면 모드와 무관하게 프록시 대상으로 쓴다.
  if (command === "serve" && !isPreview) requireDevProxyApiBase(env);
  const devProxyTarget = env.VITE_API_BASE?.trim() || undefined;
  const buildId=dashboardBuildIdentity(command,__dirname);

  return {
    define: {
      // 사용 로그의 appVersion 정본. 별도 env 를 새로 만들지 않고
      // 이미 있는 패키지 버전을 빌드 타임에 박는다.
      __DASHBOARD_VERSION__: JSON.stringify(dashboardVersion),
      __DASHBOARD_BUILD_ID__: JSON.stringify(buildId),
    },
    plugins: [
      tailwindcss(),
      react(),
      brandIcons(),
      dashboardBuildManifest(buildId),
      VitePWA(DASHBOARD_PWA_OPTIONS),
    ],
    root: ".",
    // 워크트리 사이에서 공유하는 node_modules/.vite 캐시가 체크아웃 절대경로 때문에
    // 매번 무효화되어 첫 적재가 느려지던 문제를 막는다(카드 #1460).
    cacheDir: ".vite-cache",
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
        // zod: soul-ui FolderDialog에서 사용 (@hookform/resolvers 포함)
        // pnpm 모듈 해석 경로 불일치로 zod/v4/core를 못 찾는 문제 해결
        "zod": resolve(__dirname, "../packages/soul-ui/node_modules/zod"),
      },
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
      chunkSizeWarningLimit: 725,
      rollupOptions: {
        onwarn: handleRollupWarning,
        output: {
          manualChunks(id) {
            if (id.includes("/packages/soul-ui/src/")) {
              return "soul-ui";
            }
            if (!id.includes("/node_modules/")) {
              return undefined;
            }
            if (id.includes("/@tanstack/")) {
              return "vendor-tanstack";
            }
            if (id.includes("/@dnd-kit/")) {
              return "vendor-dnd";
            }
            if (
              id.includes("/@base-ui/") ||
              id.includes("/@floating-ui/")
            ) {
              return "vendor-ui";
            }
            if (id.includes("/lucide-react/") || id.includes("/lucide/")) {
              return "vendor-icons";
            }
            if (id.includes("/node_modules/react-dom/")) {
              return "vendor-react-dom";
            }
            // Match package roots so Zustand's react/shallow stays in vendor.
            if (id.includes("/node_modules/react/") || id.includes("/node_modules/scheduler/")) {
              return "vendor-react";
            }
            if (id.includes("/heic2any/")) {
              return "vendor-heic2any";
            }
            // 스트리밍 마크다운은 동적 import로만 받는다. 자기 묶음에 두어 초기 로딩에
            // 실리지 않게 한다(카드 #1808).
            if (id.includes("/@pierre/words/")) {
              return "vendor-words";
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
