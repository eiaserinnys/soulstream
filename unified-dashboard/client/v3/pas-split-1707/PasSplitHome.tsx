import { useEffect, useRef, type RefObject } from "react";
import { FileText, Folder } from "lucide-react";

import type { FolderDocument } from "./pas-split-1707-data";

export function PasSplitHome({
  route, documents, pendingCount, runningCount, awaitingCount, queuedCount, holdCount,
  onNavigate, onOpenDocument, docTriggerRefs,
}: {
  route: "home" | "folder-docs";
  documents: FolderDocument[];
  pendingCount: number;
  runningCount: number;
  awaitingCount: number;
  queuedCount: number;
  holdCount: number;
  onNavigate(route: "home" | "folder-docs"): void;
  onOpenDocument(documentId: string): void;
  docTriggerRefs: RefObject<Record<string, HTMLButtonElement | null>>;
}) {
  const docsRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (route === "folder-docs") docsRef.current?.scrollIntoView({ block: "start" });
  }, [route]);

  return <main className="pas-home" data-testid="pas-home" data-focus={route === "folder-docs" ? "docs" : undefined}>
    <nav className="pas-home-subnav" aria-label="홈 보기">
      <button type="button" className="pas-split-nav-item" aria-current={route === "home" ? "page" : undefined}
        onClick={() => onNavigate("home")}>오늘</button>
      <button type="button" className="pas-split-nav-item" aria-current={route === "folder-docs" ? "page" : undefined}
        onClick={() => onNavigate("folder-docs")}>폴더 문서</button>
    </nav>

    <section className="pas-home-planner" aria-label="오늘 플래너">
      <div className="v3-date-head">
        <div><span>DAILY</span><h1>11월 19일 수요일</h1></div>
      </div>
      <p className="pas-home-summary">미결재 {pendingCount}건, 진행 중 {runningCount}건, 검증 대기 {awaitingCount}건</p>
      <ul className="pas-home-list">
        <li className="pas-home-row">
          <span className="pas-home-row-title"><Folder className="size-4" aria-hidden="true"/>✨ 소울스트림</span>
          <span className="pas-home-row-meta">문서 {documents.length}건, 카드 {pendingCount}건</span>
        </li>
        <li className="pas-home-row">
          <span className="pas-home-row-title"><Folder className="size-4" aria-hidden="true"/>🔮 kaleidoscope</span>
          <span className="pas-home-row-meta">진행 중 1건</span>
        </li>
      </ul>
      <div className="pas-home-hold">
        <strong>보류함 {holdCount}건</strong>
        <span>이번 주에는 보류로 옮기지 않고 문서나 검증 대기로 정리합니다.</span>
      </div>
    </section>

    <section ref={docsRef} className="pas-home-folder" aria-label="✨ 소울스트림 폴더">
      <header className="pas-home-folder-head">
        <h2>✨ 소울스트림</h2>
        <p>폴더 문서 {documents.length}건</p>
      </header>

      <div className="pas-home-docs">
        <h3>문서</h3>
        <ul className="pas-home-doc-list">
          {documents.map(document => <li key={document.id}>
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
        </ul>
      </div>

      <div className="pas-home-board">
        <h3>카드</h3>
        <div className="pas-home-board-grid">
          {[
            { id: "running", label: "진행 중", count: runningCount },
            { id: "review", label: "검수", count: pendingCount },
            { id: "awaiting", label: "검증 대기", count: awaitingCount },
            { id: "queued", label: "대기열", count: queuedCount },
            { id: "hold", label: "보류", count: holdCount },
          ].map(column => <div className="pas-home-board-column" key={column.id} data-board-column={column.id}>
            <span>{column.label}</span>
            <strong>{column.count}</strong>
          </div>)}
        </div>
      </div>
    </section>
  </main>;
}
