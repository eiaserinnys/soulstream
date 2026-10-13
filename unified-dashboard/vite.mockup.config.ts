import { defineConfig, type UserConfig } from "vite";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

import dashboardConfig from "./vite.config";

// 시안(목업) 전용 빌드. 운영 대시보드와 같은 소스, 같은 Tailwind 플러그인,
// 같은 alias로 실제 컴포넌트를 묶어 정적 파일 묶음으로 내보낸다.
// 사용: MOCKUP=<mockups 아래 폴더> vite build --config vite.mockup.config.ts
const name = process.env.MOCKUP?.trim();
if (!name || !/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
  throw new Error("MOCKUP=<mockups 아래 폴더 이름>이 필요합니다.");
}
const root = resolve(__dirname, "mockups", name);
if (!existsSync(join(root, "frame.html"))) throw new Error(`${root}/frame.html 이 없습니다.`);
const outDir = resolve(__dirname, "dist-mockups", name);

// alias와 define은 운영 설정에서 그대로 가져온다. 따로 적으면 어긋난다.
const production = (dashboardConfig as (env: { command: "build"; mode: string }) => UserConfig)({
  command: "build", mode: "production",
});

// 폰트, 초상, 캐릭터처럼 앱이 루트 주소로 부르는 정적 자원. 운영과 같은 파일을 그대로 싣는다.
const publicDir = resolve(__dirname, "public");
const input: Record<string, string> = { frame: join(root, "frame.html") };
if (existsSync(join(root, "index.html"))) input.index = join(root, "index.html");

export default defineConfig({
  root,
  // 발행 주소가 /d/<slug>/ 아래이므로 모든 자원을 상대 경로로 낸다.
  base: "./",
  publicDir,
  define: production.define,
  plugins: [tailwindcss(), react()],
  resolve: production.resolve,
  build: { outDir, emptyOutDir: true, rollupOptions: { input } },
  server: { fs: { allow: [resolve(__dirname, "..")] } },
});
