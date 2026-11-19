// 시안 A: 홈 플래너, PAS, 전용 결재 데스크, 카드 보드와 참고 서재를 한 흐름으로 올린다.
// 운영 라우트는 건드리지 않고, 실제 컴포넌트와 토큰만 시안 전용 화면에서 조립한다.
import "../_shell/mock-env";
import { mockApi, mockImages } from "../_shell/mock-env";
import { mountMockup } from "../_shell/MockupShell";
import { ApprovalDeskDashboardMockup } from "../../client/v3/approval-desk-1707/ApprovalDeskDashboardMockup";
import { DOC_1387 } from "../../client/v3/approval-desk-1707/approval-desk-data";

// 담당마다 다른 초상을 쓴다. 기본 초상 규칙보다 앞에 두어 이름과 그림이 어긋나지 않게 한다.
mockImages([
  { pattern: /^\/api\/nodes\/[^/]+\/agents\/seosoyoung\/portrait$/, file: "characters/seosoyoung/still.png" },
  { pattern: /^\/api\/nodes\/[^/]+\/agents\/roselin\/portrait$/, file: "mockup-1707/roselin.svg" },
  { pattern: /^\/api\/nodes\/[^/]+\/agents\/keke\/portrait$/, file: "mockup-1707/keke.svg" },
  { pattern: /^\/api\/nodes\/[^/]+\/agents\/selaphiel\/portrait$/, file: "mockup-1707/selaphiel.svg" },
]);

mockApi({
  "GET /api/markdown-documents/doc-1387": DOC_1387,
  "GET /api/sessions": { sessions: [], total: 0, hasMore: false },
  "POST /api/sessions/mock-pas-seosoyoung/intervene": { ok: true, delivered: true, reason: null, consume_when: null },
  // 정본 도구 막대의 영구 세션 입구가 목록을 먼저 읽는다. 시안에서는 빈 목록으로 둔다.
  "GET /api/persistent-sessions": {
    sessions: [],
    total: 0,
    create_defaults: {
      node_id: "eiaserinnys",
      preferred_agent_id: "seosoyoung",
      settings: {
        default_model: { model_preset: "sol", reasoning_effort: null },
        fallback_models: [],
        show_generation_separator: true,
        show_character: true,
        show_jev_candidates: true,
        show_work_details: true,
        animate_character: true,
        turn_usage_mode: "caption",
        show_turn_usage: true,
      },
      initial_instruction: "",
      unavailable_reason: null,
    },
  },
});

mountMockup(<ApprovalDeskDashboardMockup />, { surface: "bare" });
