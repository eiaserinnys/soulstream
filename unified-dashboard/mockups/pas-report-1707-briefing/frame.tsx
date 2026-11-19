// 카드 #1707 시안 A. PAS 화면과 한 장 결재 브리핑 갑지를 서버 없이 세운다.
import { mockAgentPortraits, mockApi } from "../_shell/mock-env";
import { mountMockup } from "../_shell/MockupShell";
import { PasReportBriefingMockup } from "../../client/v3/pas-report-briefing-1707/PasReportBriefingMockup";
import { DESIGN_DOCUMENT, PAS_SESSION_ID } from "../../client/v3/pas-report-briefing-1707/data";

// 다섯 안건의 담당 초상이 서로 다르게 보이도록 실제 인물 그림을 건다.
mockAgentPortraits();

mockApi({
  // 갑지 하단 지시 입력은 정본 ChatInput과 같은 주입 주소로 보낸다.
  [`POST /api/sessions/${PAS_SESSION_ID}/intervene`]: { delivered: true, reason: null, consumeWhen: "next_turn" },
  // #1387 설계 근거 문서는 정본 문서 열람 창이 읽는 주소로 준다.
  [`GET /api/markdown-documents/${DESIGN_DOCUMENT.id}`]: { ...DESIGN_DOCUMENT, version: 1 },
  // 채팅 입력 곁의 런타임 패널이 세션 진입 때 읽는 주소. 빈 상태로 답한다.
  [`GET /api/sessions/${PAS_SESSION_ID}/background-tasks`]: {
    sessionId: PAS_SESSION_ID, sessionState: "idle", runtimeSessionId: null, updatedAt: null,
    tasks: [], notifications: [], remoteTriggers: [], transcriptMirror: null, planMode: null, worktreeMode: null,
  },
  [`GET /api/sessions/${PAS_SESSION_ID}/schedules`]: { sessionId: PAS_SESSION_ID, nextRunAt: null, schedules: [] },
  [`GET /api/sessions/${PAS_SESSION_ID}/resume-after-limit`]: { eligible: false, reason: null, resets_at: null, schedule: null },
});

mountMockup(<PasReportBriefingMockup />, { surface: "bare" });
