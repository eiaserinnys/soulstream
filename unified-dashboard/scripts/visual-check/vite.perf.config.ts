// 카드 #1808: 스트리밍 성능 표본을 운영과 같은 vite build 묶음으로 만든다.
//
// 대시보드의 vite.config.ts를 그대로 불러 입력만 표본 html로 바꾼다. Rollup과
// 최소화, manualChunks가 운영 빌드와 같아야 표본의 성능을 운영 근거로 쓸 수 있다.
// 서비스 워커와 매니페스트는 표본에 필요 없어 PWA 플러그인만 뺀다. 산출물은
// 대시보드 dist가 아니라 STREAM_MARKDOWN_PERF_OUT(단위 폴더 work/ 아래)에 둔다.
import { resolve } from "node:path";

import {
  mergeConfig,
  type ConfigEnv,
  type PluginOption,
  type UserConfig,
} from "vite";

import dashboardConfig from "../../vite.config";

const dashboardRoot = resolve(__dirname, "../..");
const sampleHtml = resolve(__dirname, "stream-markdown-perf.html");
const outDir = process.env.STREAM_MARKDOWN_PERF_OUT;

if (!outDir) {
  throw new Error(
    "STREAM_MARKDOWN_PERF_OUT가 필요합니다. 표본 묶음을 둘 폴더를 지정하십시오.",
  );
}

const dashboard = (dashboardConfig as unknown as (env: ConfigEnv) => UserConfig)({
  command: "build",
  mode: "production",
  isPreview: false,
});

function flattenPlugins(options: PluginOption[]): PluginOption[] {
  return options.flatMap((option) =>
    Array.isArray(option) ? flattenPlugins(option) : [option],
  );
}

// vite-plugin-pwa가 내는 플러그인들(이름이 vite-plugin-pwa로 시작한다)은 표본에서 뺀다.
const plugins = flattenPlugins(dashboard.plugins ?? []).filter((plugin) => {
  const name =
    plugin && typeof plugin === "object" && "name" in plugin
      ? (plugin as { name?: string }).name
      : undefined;
  return !(typeof name === "string" && name.startsWith("vite-plugin-pwa"));
});

export default mergeConfig(
  { ...dashboard, plugins: [] },
  {
    root: dashboardRoot,
    // 표본 빌드가 대시보드의 개발 캐시와 섞이지 않게 따로 둔다.
    cacheDir: resolve(outDir, ".vite-cache"),
    // 표본은 정적 자산을 쓰지 않는다. 대시보드 public 폴더를 복사하지 않는다.
    publicDir: false,
    plugins,
    build: {
      outDir,
      emptyOutDir: true,
      minify: "esbuild",
      rollupOptions: {
        input: sampleHtml,
      },
    },
  },
);
