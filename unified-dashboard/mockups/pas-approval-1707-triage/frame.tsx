// 시안 C: 홈 플래너 3단 트리아지 장부와 지켜보는 중 선반.
// 배경과 유리는 운영 기본값을 그대로 쓴다(테마에 맞춰 바뀌는 WallpaperLayer).
// 본문 틀은 시안이 직접 세운다(surface: "bare").
import { HomePlannerTriageMockup } from "../../client/v3/home-triage-1707/HomePlannerTriageMockup";
import { mountMockup } from "../_shell/MockupShell";
import { mockApi, mockImages } from "../_shell/mock-env";

// CardWorkspace 가 세션 목록을 한 번 조회한다. 견본에는 연결 세션이 없으므로 빈 목록을 준다.
mockApi({ "GET /api/sessions": { sessions: [], total: 0 } });

// 담당 에이전트와 PAS 진입의 초상을 각자의 그림으로 응답한다.
// 구체 경로를 먼저 등록해야 기본 초상(system-portrait.png)보다 앞선다.
mockImages([
  { pattern: /^\/api\/nodes\/[^/]+\/agents\/seosoyoung\/portrait$/, file: "characters/seosoyoung/still.png" },
  { pattern: /^\/api\/nodes\/[^/]+\/agents\/roselin\/portrait$/, file: "mockup-portraits/roselin.png" },
  { pattern: /^\/api\/nodes\/[^/]+\/agents\/kiki\/portrait$/, file: "mockup-portraits/kiki.png" },
  { pattern: /^\/api\/nodes\/[^/]+\/agents\/ariella\/portrait$/, file: "mockup-portraits/ariella.png" },
  { pattern: /^\/api\/nodes\/[^/]+\/agents\/selaphiel\/portrait$/, file: "mockup-portraits/selaphiel.png" },
]);

mountMockup(<HomePlannerTriageMockup />, { surface: "bare" });
