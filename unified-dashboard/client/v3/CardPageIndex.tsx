import { useId, useState, type ReactNode } from "react";
import { Button, MarkdownContent, ProfileAvatar } from "@seosoyoung/soul-ui";
import { MarkdownImage } from "@seosoyoung/soul-ui/components/MarkdownImage";
import { ArrowLeft, Image as ImageIcon, Link, TriangleAlert } from "lucide-react";
import { CardStatusChip } from "./CardActions";
import { CardImageViewer, type CardImageSelection } from "./CardImageViewer";
import { DetailTabs } from "./DetailTabs";
import { FrontRow, FrontRowGroup } from "./FrontRow";
import { FrontPageGnb, type FrontTab } from "./front-page-parts";
import { ledgerStamp, projectName, type FrontCardDetail, type FrontCardEntry, type FrontCardItem } from "./front-page-model";
import "./v3-card-check-items.css";
import "./v3-front-index.css";

type Section = "comments" | "notes" | "sessions";
const SECTIONS = [["comments", "커멘트"], ["notes", "노트"], ["sessions", "세션"]] as const;

const ITEM_DISPLAY = { todo: "todo", doing: "doing", done: "reported", dropped: "dropped" } as const;

/**
 * 1면에서 들어간 카드 한 장. 서재의 글 한 편처럼 읽는 화면이다.
 * 머리(표지, 상태, 제목, 상황판), 확인 항목 장부, 커멘트와 노트와 세션 탭, 메타만 둔 곁단.
 */
export function CardPageIndex({ card, now, timeZone, dock, onBack, onOpenSearch, onOpenConfig }: {
  card: FrontCardDetail; now: Date; timeZone?: string; dock: ReactNode; onBack(): void;
  onOpenSearch?(): void; onOpenConfig?(): void;
}) {
  const ids = useId();
  const [section, setSection] = useState<Section>("comments");
  const [image, setImage] = useState<CardImageSelection | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const stamp = (iso: string) => <time dateTime={iso}>{ledgerStamp(iso, now, timeZone)}</time>;
  const assignee = card.sessions.find(session => session.id === card.now?.sessionId);
  const askVisible = card.now?.turn === "user" && card.now.ask && !acknowledged;
  const entries = (kind: FrontCardEntry["kind"]) => card.entries.filter(entry => entry.kind === kind);

  return <div className="v3-front-page fi-page fi-card" data-surface="paper" data-testid="card-page-index">
    <FrontPageGnb glass={false} idPrefix={`${ids}-tab`} panelId={`${ids}-panel`} tab="cards"
      onTab={(tab: FrontTab) => { if (tab === "front") onBack(); }} onOpenSearch={onOpenSearch} onOpenConfig={onOpenConfig} />

    <div className="fi-card-layout" id={`${ids}-panel`} role="tabpanel" aria-labelledby={`${ids}-tab-cards`}>
      <article className="fi-card-main">
        <header className="fi-card-head">
          <Button variant="ghost" size="sm" className="fi-back" onClick={onBack}>
            <ArrowLeft aria-hidden="true" />1면
          </Button>
          <div className="fi-card-kicker">
            <span className="fi-kicker">{projectName(card.project)}</span>
            <CardStatusChip card={{ status: card.status, blockedKind: null }} />
          </div>
          <h1 className="fi-card-title">{card.title}</h1>
          {card.now ? <p className="fi-card-now">{card.now.text}</p> : null}
          {askVisible ? <div className="fi-card-ask">
            <p>{card.now!.ask}</p>
            <Button variant="outline" onClick={() => setAcknowledged(true)}>확인했어</Button>
          </div> : null}
        </header>

        <section aria-labelledby={`${ids}-items`}>
          <h2 className="v3-front-head" id={`${ids}-items`}>확인 항목</h2>
          <FrontRowGroup>
            {card.items.map(item => <FrontRow key={item.id} rowKey={`item-${item.id}`}
              stamp={<span className="fi-item-mark">
                <i className={`v3-card-progress-dot v3-card-progress-dot--${ITEM_DISPLAY[item.state]}`} aria-hidden="true" />
                <span className="fi-item-number">{item.id}</span>
              </span>}
              line1={item.title}
              line2={item.result ? <span className="fi-quiet">{item.result}</span> : undefined}
              extra={hasItemExtra(item) ? <ItemExtra item={item} onOpenImage={(src, alt) => setImage({ src, alt })} /> : undefined} />)}
          </FrontRowGroup>
        </section>

        <section className="fi-card-sections">
          <DetailTabs<Section> id={`${ids}-section`} label="카드 기록" panelId={`${ids}-section-panel`} variant="card"
            tabs={SECTIONS} value={section} onChange={setSection} />
          <div id={`${ids}-section-panel`} role="tabpanel" aria-labelledby={`${ids}-section-${section}`}>
            {section === "sessions" ? <ul className="fi-entries">
              {card.sessions.map(session => <li key={session.id} className="fi-entry">
                <span className="fi-stamp">{stamp(session.updatedAt)}</span>
                <span className="fi-lines">
                  <span className="fi-line1">{session.title}</span>
                  <span className="fi-line2 fi-quiet fi-meta-row"><span>{session.agentId}</span><span>{session.modelPreset}</span></span>
                </span>
              </li>)}
            </ul> : <ul className="fi-entries">
              {entries(section === "comments" ? "comment" : "note").map(entry => <li key={entry.createdAt} className="fi-entry">
                <span className="fi-stamp">{stamp(entry.createdAt)}</span>
                <div className="fi-entry-body">
                  <ProfileAvatar role={entry.authorKind === "agent" ? "assistant" : "user"} hasPortrait={false} fallbackEmoji={entry.authorKind === "agent" ? "🤖" : "👤"} />
                  <MarkdownContent content={entry.body} />
                </div>
              </li>)}
            </ul>}
          </div>
        </section>
      </article>

      <aside className="fi-card-side" aria-label="카드 정보">
        <dl>
          <div><dt>노드</dt><dd>{card.nodeId}</dd></div>
          <div><dt>모델</dt><dd>{card.modelPreset}</dd></div>
          {assignee ? <div><dt>담당</dt><dd>{assignee.title}</dd></div> : null}
        </dl>
      </aside>
    </div>

    <div className="fi-dock-seat">{dock}</div>
    <CardImageViewer image={image} onClose={() => setImage(null)} />
  </div>;
}

function hasItemExtra(item: FrontCardItem): boolean {
  return Boolean(item.caveat) || item.evidence.length > 0;
}

/** 펼친 확인 항목: 남은 증거 그림 썸네일, 그림이 없는 증거의 이름, 못 본 것. */
function ItemExtra({ item, onOpenImage }: { item: FrontCardItem; onOpenImage(src: string, alt: string): void }) {
  const pictures = item.evidence.filter(evidence => evidence.src);
  const names = item.evidence.filter(evidence => !evidence.src);
  return <div className="fi-item-extra">
    {pictures.length ? <div className="v3-card-check-item-evidence" data-evidence-type="image">
      {pictures.map(evidence => <figure key={evidence.label} title={evidence.label}>
        <MarkdownImage variant="card-evidence" src={evidence.src!} alt={evidence.label} onOpen={onOpenImage} />
      </figure>)}
    </div> : null}
    {names.length ? <ul className="fi-evidence-names">
      {names.map(evidence => <li key={`${evidence.type}-${evidence.label}`}>
        {evidence.type === "link" ? <Link aria-hidden="true" /> : <ImageIcon aria-hidden="true" />}{evidence.label}
      </li>)}
    </ul> : null}
    {item.caveat ? <p className="v3-card-check-item-caveat"><TriangleAlert className="h-3 w-3" aria-hidden="true" /><span>{item.caveat}</span></p> : null}
  </div>;
}
