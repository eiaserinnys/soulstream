import { useRef, useState, type ReactNode } from "react";
import { Button, ProfileAvatar } from "@seosoyoung/soul-ui";
import { LayoutDashboard, List, Library } from "lucide-react";
import { PostItCardView, PostItGrid } from "../PostItCardPresentation";
import { StatusChip } from "../StatusChip";
import { GlassPanel } from "./GlassPanel";
import { FOLDERS, pendingCard, toCardRow, type PendingDoc, type ScenarioCard } from "./approval-desk-data";

const TONE = { question: "question", task: "running", review: "review" } as const;

const BOARD_COLUMNS: { key: string; label: string; count: number }[] = [
  { key: "todo", label: "드래프트", count: 0 },
  { key: "queued", label: "대기", count: 2 },
  { key: "running", label: "실행 중", count: 3 },
  { key: "blocked", label: "막힘", count: 0 },
  { key: "awaiting_verification", label: "검증 대기", count: 0 },
  { key: "review", label: "검수 대기", count: 5 },
  { key: "on_hold", label: "보류", count: 18 },
  { key: "done", label: "완료", count: 12 },
  { key: "cancelled", label: "취소", count: 0 },
];

function portraitFor(card: ScenarioCard) {
  return <ProfileAvatar role="assistant" hasPortrait portraitUrl={`/api/nodes/eiaserinnys/agents/${card.assignee.agentId}/portrait`} fallbackEmoji="🤖" />;
}

function CardTile({ card, onOpen, statusContent, variant = "default", supplement }: {
  card: ScenarioCard;
  onOpen(trigger: HTMLElement): void;
  statusContent: ReactNode;
  variant?: "default" | "compact";
  supplement?: string;
}) {
  const seat = useRef<HTMLDivElement>(null);
  const row = toCardRow(card);
  return <div ref={seat} className="ad1707-card-seat">
    <PostItCardView id={row.id} title={`#${card.number} ${card.title}`} status={row.status}
      color={row.color} fontSize={17} variant={variant}
      activity={{ kind: card.activityKind, text: card.activity }}
      assigneeName={card.assignee.name} avatar={portraitFor(card)}
      statusContent={statusContent} supplement={supplement ?? card.folder}
      onOpen={() => { if (seat.current) onOpen(seat.current); }} />
  </div>;
}

export function HomePlannerScreen({ pending, progress, queue, onHold, completed, referenceView, boardView, onToggleReference, onToggleBoard, onOpenDesk, onOpenPending, onOpenCard }: {
  pending: PendingDoc[];
  progress: ScenarioCard[];
  queue: ScenarioCard[];
  onHold: ScenarioCard[];
  completed: ScenarioCard[];
  referenceView: boolean;
  boardView: boolean;
  onToggleReference(): void;
  onToggleBoard(): void;
  onOpenDesk(): void;
  onOpenPending(doc: PendingDoc, trigger: HTMLElement): void;
  onOpenCard(card: ScenarioCard, trigger: HTMLElement): void;
}) {
  const [activeFolder, setActiveFolder] = useState<string>(FOLDERS[0]);
  const [holdExpanded, setHoldExpanded] = useState(false);
  const references = completed.filter(card => card.reference);

  return <div className="ad1707-screen ad1707-home" data-screen="home">
    <div className="ad1707-home-shell">
      <GlassPanel as="aside" className="v3-navigation ad1707-nav" aria-label="폴더">
        <div className="v3-navigation-scroll">
          <div className="v3-brand"><span aria-hidden="true">✨</span><strong>소울스트림</strong></div>
          <h2>폴더</h2>
          <div className="v3-nav-list">
            {FOLDERS.map(folder => <button key={folder} type="button"
              className={folder === activeFolder ? "is-active" : undefined}
              aria-current={folder === activeFolder ? "true" : undefined}
              onClick={() => setActiveFolder(folder)}>{folder}</button>)}
          </div>
        </div>
      </GlassPanel>

      <main className="ad1707-home-main">
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
          <div className="ad1707-board" role="list">
            {BOARD_COLUMNS.map(column => {
              const cards = column.key === "queued" ? queue
                : column.key === "running" ? progress
                : column.key === "review" ? [] : column.key === "on_hold" ? onHold
                : column.key === "done" ? completed : [];
              const count = column.key === "review" ? pending.length
                : column.key === "done" ? completed.length
                : column.key === "on_hold" ? onHold.length : column.count;
              const shown = column.key === "on_hold" && !holdExpanded ? cards.slice(0, 3) : cards;
              return <section key={column.key} className="ad1707-board-column" role="listitem" data-board-column={column.key}>
                <div className="v3-detail-section-head">
                  <h3>{column.label}</h3><span>{count}개</span>
                </div>
                <div className="ad1707-board-lane">
                  {column.key === "review" ? pending.map(doc => <CardTile key={doc.id} card={pendingCard(doc)} variant="compact"
                    statusContent={<StatusChip label={doc.kindLabel} tone={TONE[doc.kind]} />}
                    onOpen={trigger => onOpenPending(doc, trigger)} />) : shown.map(card => <CardTile key={card.id} card={card} variant="compact"
                    statusContent={<StatusChip label={card.status === "done" ? (card.reference ? "참고" : "완료") : card.status === "on_hold" ? "보류" : card.status === "running" ? "실행 중" : "대기"} tone={card.status === "done" ? "done" : card.status === "on_hold" ? "open" : "running"} />}
                    onOpen={trigger => onOpenCard(card, trigger)} />)}
                  {column.key === "on_hold" && !holdExpanded && onHold.length > 3 ? <Button variant="ghost" size="sm"
                    className="ad1707-board-more" onClick={() => setHoldExpanded(true)}>나머지 {onHold.length - 3}건 더 보기</Button> : null}
                  {count === 0 ? <p className="v3-card-board-empty">카드가 없습니다</p> : null}
                </div>
              </section>;
            })}
          </div>
        </section> : <>
          <section className="ad1707-home-group" data-card-group="attention" aria-label="확인할 것">
            <div className="v3-section-head ad1707-group-head">
              <h2>확인할 것</h2><span>{pending.length}</span><span className="v3-spacer" />
              <Button variant="glass" size="sm" onClick={onOpenDesk}>결재 데스크로 넘겨 보기</Button>
            </div>
            <PostItGrid fontSize={17}>
              {pending.map(doc => <CardTile key={doc.id} card={pendingCard(doc)}
                statusContent={doc.scheduledUntil
                  ? <StatusChip label={`다시 보기 예약 ${doc.scheduledUntil}`} tone="open" />
                  : <StatusChip label={doc.kindLabel} tone={TONE[doc.kind]} />}
                onOpen={trigger => onOpenPending(doc, trigger)} />)}
            </PostItGrid>
          </section>
          <section className="ad1707-home-group" data-card-group="running" aria-label="진행 중">
            <div className="v3-section-head ad1707-group-head"><h2>진행 중</h2><span>{progress.length}</span></div>
            <PostItGrid fontSize={17}>
              {progress.map(card => <CardTile key={card.id} card={card}
                statusContent={<StatusChip label="실행 중" tone="running" />}
                onOpen={trigger => onOpenCard(card, trigger)} />)}
            </PostItGrid>
          </section>
          <section className="ad1707-home-group" data-card-group="queued" aria-label="대기열">
            <div className="v3-section-head ad1707-group-head"><h2>대기열</h2><span>{queue.length}</span></div>
            <PostItGrid fontSize={17}>
              {queue.map(card => <CardTile key={card.id} card={card}
                statusContent={<StatusChip label="대기" tone="open" />}
                onOpen={trigger => onOpenCard(card, trigger)} />)}
            </PostItGrid>
          </section>
        </>}
      </main>
    </div>
  </div>;
}
