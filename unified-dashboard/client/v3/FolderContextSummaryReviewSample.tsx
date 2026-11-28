import { dialoguesAssignment } from "./dialogues-api";
import { FolderContextSummary } from "./FolderContextSummary";
import { mergeProjectContextPages } from "./project-context-inheritance";
import type { ProjectPageDetails } from "./project-page-details";

const own: ProjectPageDetails = {
  guidance: [{ blockId: "g", text: "결정은 실제 근거와 함께 기록하고, 구현 뒤 다크와 라이트 화면을 모두 검증한다. 화면을 바꾸면 검수 창 견본도 함께 고친다.", scope: "project" }],
  atomReferences: [
    { blockId: "a1", instance: "atom", nodeId: "front", nodeTitle: "프론트엔드 아키텍처", depth: 2, titlesOnly: true },
    { blockId: "a2", instance: "atom", nodeId: "ui", nodeTitle: "UI 디자인 기준", depth: 1, titlesOnly: false },
  ],
  sessionDefaults: [{ blockId: "d", scope: "session", agentId: "roselin", nodeId: "sample-node", modelPreset: "sample-sol" }],
};
const empty: ProjectPageDetails = { guidance: [], atomReferences: [], sessionDefaults: [] };
const inherited = mergeProjectContextPages([{ source: { folderId: "parent", folderName: "소울스트림", pageId: "parent-page" }, details: own }]);

export function FolderContextSummaryReviewSample({ onOpenSettings }: { onOpenSettings(): void }) {
  return <div className="v3-components-panel-pair">
    <FolderContextSummary details={own} inherited={null} assignment={dialoguesAssignment} onOpenSettings={onOpenSettings} />
    <FolderContextSummary details={empty} inherited={inherited} assignment={dialoguesAssignment} onOpenSettings={onOpenSettings} />
    <FolderContextSummary details={empty} inherited={null} assignment={dialoguesAssignment} onOpenSettings={onOpenSettings} />
  </div>;
}
