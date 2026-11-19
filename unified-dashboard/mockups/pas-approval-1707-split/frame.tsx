// 시안 B: PAS 지휘실 2단 스플릿과 폴더 문서 승격.
// 운영 화면과 같은 토큰, 같은 컴포넌트를 정적 묶음 위에서 돌린다.
import { mockApi } from "../_shell/mock-env";
import { mountMockup } from "../_shell/MockupShell";
import { useDashboardStore } from "@seosoyoung/soul-ui";
import { PasSplitCommandMockup } from "../../client/v3/pas-split-1707/PasSplitCommandMockup";
import { DOCUMENT_BODIES } from "../../client/v3/pas-split-1707/pas-split-1707-data";

// 폴더 문서 리더가 부르는 본문. 문서 id가 그대로 API 경로가 된다.
mockApi(Object.fromEntries(
  Object.entries(DOCUMENT_BODIES).map(([id, document]) => [`GET /api/markdown-documents/${id}`, document]),
));

// 읽기 편한 사진 바탕과 유리 표면. 운영 기본값을 시안에 맞춰 한 번만 세운다.
const wallpaper = new URL("./wallpaper.jpg", import.meta.url).href;
useDashboardStore.getState().setWallpaper({ mode: "photo", customImage: wallpaper });
useDashboardStore.getState().setLiquidGlass({
  blur: 5, tint: 0.42, enabled: true, specular: 0.25, chromatic: 0.8, refraction: 66,
});

mountMockup(<PasSplitCommandMockup />, { surface: "bare" });
