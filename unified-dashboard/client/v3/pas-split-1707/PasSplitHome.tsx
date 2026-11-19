import { useMemo, useState, type RefObject } from "react";
import { FileText, Folder } from "lucide-react";

import { CardBoardWorkspace } from "../CardBoardWorkspace";
import { DetailTabs } from "../DetailTabs";
import { PostItCardView } from "../PostItCard";
import { ProjectNavigationTree } from "../ProjectNavigationTree";
import {
  HOLD_COUNT, HOME_CARDS, HOME_FOLDERS, homeAssignee,
  type FolderDocument, type HomeAgentId,
} from "./pas-split-1707-data";

type HomeView = "docs" | "cards" | "board";

const STATUS_LABELS: Record<string, string> = {
  running: "실행 중",
  awaiting_verification: "검증 대기",
  on_hold: "보류",
  done: "완료",
};

function descendantFolderIds(folderId: string): Set<string> {
  const ids = new Set([folderId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const folder of HOME_FOLDERS) {
      if (folder.parentFolderId && ids.has(folder.parentFolderId) && !ids.has(folder.id)) {
        ids.add(folder.id);
        changed = true;
      }
    }
  }
  return ids;
}

export function PasSplitHome({
  route, documents, onNavigate, onOpenDocument, onOpenCard, docTriggerRefs,
}: {
  route: "home" | "folder-docs";
  documents: FolderDocument[];
  onNavigate(route: "home" | "folder-docs"): void;
  onOpenDocument(documentId: string): void;
  onOpenCard(cardId: string): void;
  docTriggerRefs: RefObject<Record<string, HTMLButtonElement | null>>;
}) {
  const [selectedFolderId, setSelectedFolderId] = useState("folder-soulstream");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ "folder-soulstream": true });
  const [viewOverride, setViewOverride] = useState<HomeView | null>(null);
  const [includeCompleted, setIncludeCompleted] = useState(true);
  const view: HomeView = route === "folder-docs" ? "docs" : viewOverride ?? "cards";

  const folderIds = useMemo(() => descendantFolderIds(selectedFolderId), [selectedFolderId]);
  const folder = HOME_FOLDERS.find(item => item.id === selectedFolderId) ?? HOME_FOLDERS[0];
  const folderDocuments = documents.filter(document => folderIds.has(document.folderId));
  const folderCards = useMemo(
    () => HOME_CARDS.filter(card => folderIds.has(card.folderId)),
    [folderIds],
  );

  const selectView = (next: HomeView) => {
    setViewOverride(next);
    onNavigate(next === "docs" ? "folder-docs" : "home");
  };

  return <main className="pas-home" data-testid="pas-home" data-focus={view === "docs" ? "docs" : undefined}>
    <nav className="pas-home-nav glass-strong glass-chrome lg-rim" aria-label="폴더 트리">
      <div className="pas-home-nav-scroll">
        <h2>전체 프로젝트</h2>
        <ProjectNavigationTree
          folders={HOME_FOLDERS}
          selectedFolderId={selectedFolderId}
          isExpanded={folderId => Boolean(expanded[folderId])}
          onToggleExpanded={folderId => setExpanded(current => ({ ...current, [folderId]: !current[folderId] }))}
          onSelect={item => setSelectedFolderId(item.id)}
          onContextMenu={event => event.preventDefault()}
          onReorder={async () => {}}
        />
      </div>
    </nav>

    <section className="pas-home-planner glass-strong glass-chrome lg-rim" aria-label="홈 플래너">
      <div className="pas-home-planner-head">
        <div className="v3-date-head">
          <div><span>DAILY</span><h1>11월 19일 수요일</h1></div>
        </div>
        <p className="pas-home-folder-caption"><Folder className="size-4" aria-hidden="true"/>{folder.name}</p>
      </div>

      <div className="pas-home-tabs">
        <DetailTabs id="pas-home-view" label="홈 보기" panelId="pas-home-view-panel"
          tabs={[["docs", "폴더 문서"], ["cards", "카드 목록"], ["board", "칸반 보드"]] as const}
          value={view} onChange={selectView}/>
      </div>

      {view === "board" ? <div className="pas-home-board-view" id="pas-home-view-panel" role="tabpanel">
        <div className="v3-card-home pas-home-board">
          <CardBoardWorkspace title={`${folder.name} 카드`} cards={folderCards}
            completion={{ includeCompleted, onChange: setIncludeCompleted }}
            renderCard={card => {
              const agentId = (card.assigneeAgentId ?? "seosoyoung") as HomeAgentId;
              return <PostItCardView card={card} variant="compact"
                activity={card.latestActivity ?? null}
                assignee={homeAssignee(agentId)}
                onOpen={() => onOpenCard(card.id)}/>;
            }}/>
        </div>
      </div> : <div className="pas-home-planner-scroll" id="pas-home-view-panel" role="tabpanel">
        {view === "docs" ? <>
          <h2 className="pas-home-section-title">폴더 문서</h2>
          {folderDocuments.length > 0 ? <ul className="pas-home-doc-list">
            {folderDocuments.map(document => <li key={document.id}>
              <button type="button" className="pas-home-doc-row" data-document-id={document.id}
                ref={element => { docTriggerRefs.current[document.id] = element; }}
                onClick={() => onOpenDocument(document.id)}>
                <FileText className="size-4" aria-hidden="true"/>
                <span className="pas-home-doc-copy">
                  <strong>{document.title}</strong>
                  <small>{document.date}, {document.summary}</small>
                </span>
              </button>
            </li>)}
          </ul> : <p className="pas-home-empty">이 폴더에 문서가 없습니다.</p>}
        </> : <><h2 className="pas-home-section-title">카드 목록</h2>
          {folderCards.length > 0 ? <ul className="pas-home-card-list">
            {folderCards.map(card => <li key={card.id}>
              <button type="button" className="pas-home-card-row" data-card-id={card.id}
                onClick={() => onOpenCard(card.id)}>
                <span className="pas-home-card-number">#{card.number}</span>
                <span className="pas-home-card-copy">
                  <strong>{card.title}</strong>
                  <small>{homeAssignee((card.assigneeAgentId ?? "seosoyoung") as HomeAgentId).agentName}</small>
                </span>
                <span className="pas-home-card-status" data-status={card.status}>{STATUS_LABELS[card.status] ?? card.status}</span>
              </button>
            </li>)}
          </ul> : <p className="pas-home-empty">이 폴더에 카드가 없습니다.</p>}</>}

        <div className="pas-home-hold">
          <strong>보류함 {HOLD_COUNT}건</strong>
          <span>이번 주에는 보류로 옮기지 않고 문서나 검증 대기로 정리합니다.</span>
        </div>
      </div>}
    </section>
  </main>;
}
