// 시안 C: PAS 시간순 통합 사건 스레드.
// 정본 PAS 화면 부품과 결재 보고 창 부품을 실제 CSS 그대로 올리고, 서버 응답만 가짜로 준다.
import { mockAgentPortraits, mockApi } from "../_shell/mock-env";
import { mountMockup } from "../_shell/MockupShell";
import { PasReportThreadMockup } from "../../client/v3/pas-report-thread-1707/PasReportThreadMockup";
import { DOCUMENT_BODIES } from "../../client/v3/pas-report-thread-1707/pas-report-thread-1707-data";

// 검수용 실패 주입: QA가 window.__pasDocFail을 세우면 문서 조회가 500으로 떨어진다.
mockApi(Object.fromEntries(Object.entries(DOCUMENT_BODIES).map(([id, document]) => [`GET /api/markdown-documents/${id}`, () => {
  if ((window as unknown as { __pasDocFail?: boolean }).__pasDocFail) {
    return new Response(JSON.stringify({ error: "mockup: document failure" }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
  return document;
}])));
// 정본 셸이 서버 상태(재시작 중 여부, atom 공개 주소)를 읽는다. 시안은 평상시 상태를 준다.
mockApi({ "GET /api/status": { is_draining: false, atom_public_url: null } });
mockAgentPortraits();

mountMockup(<PasReportThreadMockup />, { surface: "bare" });
