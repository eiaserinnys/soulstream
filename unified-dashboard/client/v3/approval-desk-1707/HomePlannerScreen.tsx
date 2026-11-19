import { useMemo, useRef, useState, type ReactNode } from "react";
import { Button, ProfileAvatar, type CatalogFolder } from "@seosoyoung/soul-ui";
import { LayoutDashboard, List, Library } from "lucide-react";
import { CardBoardWorkspace } from "../CardBoardWorkspace";
import { ProjectNavigationTree } from "../ProjectNavigationTree";
import { PostItCardView, PostItGrid } from "../PostItCardPresentation";
import { StatusChip } from "../StatusChip";
import { GlassPanel } from "./GlassPanel";
import { pendingCard, portraitUrl, toCardRow, type PendingDoc, type ScenarioCard } from "./approval-desk-data";

const TONE = { question: "question", task: "running", review: "review" } as const;

function portraitFor(card: ScenarioCard) {
  return <ProfileAvatar role="assistant" hasPortrait portraitUrl={portraitUrl(card.assignee.agentId)} fallbackEmoji="🤖" />;
}

function CardTile({ card, onOpen, statusContent, variant = "default", supplement }: {
  card: ScenarioCard;
  onOpen(trigger: HTMLElement): void;
  statusContent: ReactNode;
  variant?: "default" | "compact";
  /** null이면 폴더 이름을 감춘다. 보드의 좁은 카드에서 담당 이름 자리를 비켜 준다. */
  supplement?: string | null;
}) {
  const seat = useRef<HTMLDivElement>(null);
  const row = toCardRow(card);
  return <div ref={seat} className="ad1707-card-seat">
    <PostItCardView id={row.id} title={`#${card.number} ${card.title}`} status={row.status}
      color={row.color} fontSize={17} variant={variant}
      activity={{ kind: card.activityKind, text: card.activity }}
      assigneeName={card.assignee.name} avatar={portraitFor(card)}
      statusContent={statusContent} supplement={supplement === null ? undefined : supplement ?? card.folder}
      onOpen={() => { if (seat.current) onOpen(seat.current); }} />
  </div>;
}

function cardStatusContent(card: ScenarioCard) {
  if (card.status === "done") return <StatusChip label={card.reference ? "참고" : "완료"} tone="done" />;
  if (card.status === "on_hold") return <StatusChip label="보류" tone="open" />;
  if (card.status === "running") return <StatusChip label="실행 중" tone="running" />;
  if (card.status === "review") return <StatusChip label="검수 대기" tone="review" />;
  return <StatusChip label="대기" tone="open" />;
}

export function HomePlannerScreen({ pending, progress, queue, onHold, completed, folders, referenceView, boardView, onToggleReference, onToggleBoard, onOpenDesk, onOpenPending, onOpenCard }: {
  pending: PendingDoc[];
  progress: ScenarioCard[];
  queue: ScenarioCard[];
  onHold: ScenarioCard[];
  completed: ScenarioCard[];
  folders: readonly CatalogFolder[];
  referenceView: boolean;
  boardView: boolean;
  onToggleReference(): void;
  onToggleBoard(): void;
  onOpenDesk(): void;
  onOpenPending(doc: PendingDoc, trigger: HTMLElement): void;
  onOpenCard(card: ScenarioCard, trigger: HTMLElement): void;
}) {
  const [activeFolderId, setActiveFolderId] = useState<string | null>(null);
  const inFolder = (folderId: string) => activeFolderId === null || folderId === activeFolderId;
  const filteredPending = pending.filter(doc => inFolder(doc.folderId));
  const filteredProgress = progress.filter(card => inFolder(card.folderId));
  const filteredQueue = queue.filter(card => inFolder(card.folderId));
  const filteredOnHold = onHold.filter(card => inFolder(card.folderId));
  const filteredCompleted = completed.filter(card => inFolder(card.folderId));
  const references = filteredCompleted.filter(card => card.reference);
  const boardEntries = useMemo<{ card: ScenarioCard; doc?: PendingDoc }[]>(() => [
    ...filteredPending.map(doc => ({ card: pendingCard(doc), doc })),
    ...filteredProgress.map(card => ({ card })),
    ...filteredQueue.map(card => ({ card })),
    ...filteredOnHold.map(card => ({ card })),
    ...filteredCompleted.map(card => ({ card })),
  ], [filteredPending, filteredProgress, filteredQueue, filteredOnHold, filteredCompleted]);
  const boardCardById = new Map(boardEntries.map(entry => [entry.card.id, entry]));

  const renderBoardCard = (row: ReturnType<typeof toCardRow>) => {
    const entry = boardCardById.get(row.id);
    if (!entry) return null;
    const { card } = entry;
    return <CardTile key={card.id} card={card} variant="compact" supplement={null}
      statusContent={cardStatusContent(card)}
      onOpen={trigger => entry.doc ? onOpenPending(entry.doc, trigger) : onOpenCard(card, trigger)} />;
  };

  return <div className="ad1707-screen ad1707-home" data-screen="home">
    <div className="ad1707-home-shell">
      <GlassPanel as="aside" className="v3-navigation ad1707-nav border border-glass-border" aria-label="폴더">
        <div className="v3-navigation-scroll">
          <div className="v3-brand"><span aria-hidden="true">✨</span><strong>소울스트림</strong></div>
          <h2>폴더</h2>
          <div className="v3-nav-list">
            <ProjectNavigationTree folders={folders} selectedFolderId={activeFolderId}
              isExpanded={() => false} onToggleExpanded={() => {}}
              onSelect={folder => setActiveFolderId(current => current === folder.id ? null : folder.id)}
              onContextMenu={event => event.preventDefault()} onReorder={async () => {}} />
          </div>
        </div>
      </GlassPanel>

      <GlassPanel as="main" className="v3-planner ad1707-home-main border border-glass-border"
        data-board-view={boardView ? "true" : undefined}>
        <header className="ad1707-home-head">
          <h1>홈 플래너</h1>
          <div className="ad1707-home-actions">
            <Button variant={referenceView ? "default" : "outline"} size="sm" aria-pressed={referenceView}
              onClick={onToggleReference}>
              <Library className="size-4" aria-hidden="true" />참고 서재 {references.length}
            </Button>
            <Button variant={boardView ? "default" : "outline"} size="sm" aria-pressed={boardView}
              onClick={onToggleBoard}>
              {boardView ? <List className="size-4" aria-hidden="true" /> : <LayoutDashboard className="size-4" aria-hidden="true" />}
              {boardView ? "카드 보기" : "보드 보기"}
            </Button>
          </div>
        </header>

        {referenceView ? <section className="ad1707-home-group ad1707-reference" aria-label="참고 서재">
          <div className="v3-section-head ad1707-group-head">
            <h2>참고 서재</h2><span>{references.length}</span>
          </div>
          {references.length ? <PostItGrid fontSize={17}>
            {references.map(card => <CardTile key={card.id} card={card}
              statusContent={<StatusChip label="참고" tone="done" />}
              onOpen={trigger => onOpenCard(card, trigger)} />)}
          </PostItGrid> : <p className="ad1707-empty">참고로 갈무리한 카드가 없습니다.</p>}
        </section> : boardView ? <section className="ad1707-home-group ad1707-board-view" aria-label="카드 보드">
          <CardBoardWorkspace title="카드 보드" cards={boardEntries.map(entry => toCardRow(entry.card))}
            renderCard={renderBoardCard} completion={{ includeCompleted: true, onChange: () => {} }} />
        </section> : <>
          <section className="ad1707-home-group" data-card-group="attention" aria-label="확인할 것">
            <div className="v3-section-head ad1707-group-head">
              <h2>확인할 것</h2><span>{filteredPending.length}</span><span className="v3-spacer" />
              <Button variant="glass" size="sm" onClick={onOpenDesk}>결재 데스크로 넘겨 보기</Button>
            </div>
            <PostItGrid fontSize={17}>
              {filteredPending.map(doc => <CardTile key={doc.id} card={pendingCard(doc)}
                statusContent={doc.scheduledUntil
                  ? <StatusChip label={`다시 보기 예약 ${doc.scheduledUntil}`} tone="open" />
                  : <StatusChip label={doc.kindLabel} tone={TONE[doc.kind]} />}
                onOpen={trigger => onOpenPending(doc, trigger)} />)}
            </PostItGrid>
          </section>
          <section className="ad1707-home-group" data-card-group="running" aria-label="진행 중">
            <div className="v3-section-head ad1707-group-head"><h2>진행 중</h2><span>{filteredProgress.length}</span></div>
            <PostItGrid fontSize={17}>
              {filteredProgress.map(card => <CardTile key={card.id} card={card}
                statusContent={<StatusChip label="실행 중" tone="running" />}
                onOpen={trigger => onOpenCard(card, trigger)} />)}
            </PostItGrid>
          </section>
          <section className="ad1707-home-group" data-card-group="queued" aria-label="대기열">
            <div className="v3-section-head ad1707-group-head"><h2>대기열</h2><span>{filteredQueue.length}</span></div>
            <PostItGrid fontSize={17}>
              {filteredQueue.map(card => <CardTile key={card.id} card={card}
                statusContent={<StatusChip label="대기" tone="open" />}
                onOpen={trigger => onOpenCard(card, trigger)} />)}
            </PostItGrid>
          </section>
        </>}
      </GlassPanel>
    </div>
  </div>;
}
