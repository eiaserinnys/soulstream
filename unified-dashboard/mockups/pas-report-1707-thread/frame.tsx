// 시안 C: PAS 시간순 통합 사건 스레드.
// 정본 PAS 화면 부품과 결재 보고 창 부품을 실제 CSS 그대로 올리고, 서버 응답만 가짜로 준다.
import { mockAgentPortraits, mockApi } from "../_shell/mock-env";
import { mountMockup } from "../_shell/MockupShell";
import { PasReportThreadMockup } from "../../client/v3/pas-report-thread-1707/PasReportThreadMockup";
import { DOCUMENT_BODIES } from "../../client/v3/pas-report-thread-1707/pas-report-thread-1707-data";

mockApi(Object.fromEntries(Object.entries(DOCUMENT_BODIES).map(([id, document]) => [`GET /api/markdown-documents/${id}`, document])));
mockAgentPortraits();

mountMockup(<PasReportThreadMockup />, { surface: "bare" });
