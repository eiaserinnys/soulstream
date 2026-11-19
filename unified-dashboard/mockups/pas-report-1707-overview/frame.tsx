// 시안 B: PAS 메인의 보고 말풍선과, 탭 없이 카드 전 요소를 펼치는 3열 조감 시트.
// 운영 화면과 같은 토큰, 같은 컴포넌트를 정적 묶음 위에서 돌린다.
import { mockAgentPortraits, mockApi } from "../_shell/mock-env";
import { mountMockup } from "../_shell/MockupShell";
import { useDashboardStore } from "@seosoyoung/soul-ui/stores/dashboard-store";
import { PasReportOverviewMockup } from "../../client/v3/pas-report-overview-1707/PasReportOverviewMockup";
import {
  DOCUMENTS,
  MOCK_SESSION_ID,
  PROMOTED_DOCUMENT_ID,
} from "../../client/v3/pas-report-overview-1707/pas-report-overview-1707-data";

// 폴더 문서 리더가 부르는 본문. 문서 id가 그대로 API 경로가 된다.
mockApi(Object.fromEntries(
  Object.entries(DOCUMENTS).map(([id, document]) => [`GET /api/markdown-documents/${id}`, document]),
));

// 리더의 실패 안내와 재시도를 검수할 수 있도록, 승격 문서에만 한 번짜리 500 스위치를 둔다.
(window as unknown as { __pasRo1707FailDocumentOnce?: boolean }).__pasRo1707FailDocumentOnce = false;
mockApi({
  [`GET /api/markdown-documents/${PROMOTED_DOCUMENT_ID}`]: () => {
    const state = window as unknown as { __pasRo1707FailDocumentOnce?: boolean };
    if (state.__pasRo1707FailDocumentOnce) {
      state.__pasRo1707FailDocumentOnce = false;
      return new Response(JSON.stringify({ error: "mockup: injected document failure" }), {
        status: 500, headers: { "Content-Type": "application/json" },
      });
    }
    return DOCUMENTS[PROMOTED_DOCUMENT_ID];
  },
});

// 메인 원고지 대화 입력이 부르는 주입 경로. 응답이 와야 입력 대기가 풀린다.
mockApi({
  [`POST /api/sessions/${MOCK_SESSION_ID}/intervene`]: ({ body }: { body: unknown }) => {
    const text = (body as { text?: string } | null)?.text?.trim() ?? "";
    if (text) window.dispatchEvent(new CustomEvent("pas-ro1707:pas-chat", { detail: { text } }));
    return { delivered: true, reason: "card_question_answered", consumeWhen: null };
  },
});

// PAS 회차는 완료된 채 사용자의 다음 지시를 기다린다. 실행 중이 아니므로 중단 단추가 없다.
useDashboardStore.setState({
  activeSessionKey: MOCK_SESSION_ID,
  activeSessionSummary: {
    agentSessionId: MOCK_SESSION_ID,
    status: "completed",
    eventCount: 0,
    agentName: "서소영",
    agentId: "seosoyoung",
    displayName: "서소영 영구 세션",
    prompt: "PAS 보고 창을 결재 서류처럼 한눈에 읽고 바로 처분한다.",
  },
});

// 에이전트별 초상. 배경과 유리 표면은 운영 기본값을 그대로 쓴다.
mockAgentPortraits();

mountMockup(<PasReportOverviewMockup />, { surface: "bare" });
