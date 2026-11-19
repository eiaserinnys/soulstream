// 시안 B: PAS 지휘실 2단 스플릿과 폴더 문서 승격.
// 운영 화면과 같은 토큰, 같은 컴포넌트를 정적 묶음 위에서 돌린다.
import { mockAgentPortraits, mockApi } from "../_shell/mock-env";
import { mountMockup } from "../_shell/MockupShell";
import { PasSplitCommandMockup } from "../../client/v3/pas-split-1707/PasSplitCommandMockup";
import { DOCUMENT_BODIES } from "../../client/v3/pas-split-1707/pas-split-1707-data";

// 폴더 문서 리더가 부르는 본문. 문서 id가 그대로 API 경로가 된다.
mockApi(Object.fromEntries(
  Object.entries(DOCUMENT_BODIES).map(([id, document]) => [`GET /api/markdown-documents/${id}`, document]),
));

// 에이전트별 초상. 배경과 유리 표면은 운영 기본값을 그대로 쓴다.
mockAgentPortraits();

mountMockup(<PasSplitCommandMockup />, { surface: "bare" });
