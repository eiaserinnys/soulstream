import { useId, useRef, useState, type ReactNode } from "react";
import {
  Button, DashboardIconCap, ThemeToggle, cn, useDashboardStore, useGlassSurface, useLiquidLens,
} from "@seosoyoung/soul-ui";
import { Minus, Plus, Search, UserRound } from "lucide-react";
import { ConfigButton } from "../components/ConfigButton";
import { CardImageViewer, type CardImageSelection } from "./CardImageViewer";
import { CardProgressSummary } from "./CardProgressSummary";
import { DetailTabs } from "./DetailTabs";
import { summarizeCardItems } from "./card-item-summary";
import {
  LIMIT_REMAINING_WARNING, NODE_USAGE_WARNING, clockTime, frontPageDate, isoDate, newestFirst,
  projectIcon, projectName, splitReview, toCheckItems,
  type FrontPageCard, type FrontPageData, type FrontPageLimit, type FrontPageNode, type FrontPageQuestion,
} from "./front-page-model";
import "./persistent-session-screen.css";
import "./v3-front-page.css";

type Tab = "front" | "cards" | "record" | "projects";
const TABS = [["front", "1면"], ["cards", "카드"], ["record", "기록"], ["projects", "프로젝트"]] as const;
const QUESTION_LIMIT = 3;

interface Props {
  data: FrontPageData;
  /** 머리의 세션 시작 입력창. 운영에서는 CardHandoff를 그대로 넘긴다. */
  composer: ReactNode;
  now: Date;
  timeZone?: string;
  /** 카드 증거 그림 이름을 주소로 바꾼다. */
  imageUrl(name: string): string;
  onOpenCard?(number: number): void;
  onOpenProject?(project: string): void;
  onOpenSearch?(): void;
  onOpenConfig?(): void;
}

/**
 * 소울스트림 1면. 디렉터가 지금 알아야 할 네 갈래(볼 것, 돌아가는 일, 물어본 것, 기계)를
 * 한 화면에 조판한다. 배경이 사진이면 머리는 사진 위에, 본문은 유리 위에 두고,
 * 배경이 없으면 같은 구성을 종이 위에 괘선으로 낸다.
 */
export function FrontPage({ data, composer, now, timeZone, imageUrl, onOpenCard, onOpenProject, onOpenSearch, onOpenConfig }: Props) {
  const photo = useDashboardStore(state => state.wallpaper.mode === "photo");
  const [tab, setTab] = useState<Tab>("front");
  const [image, setImage] = useState<CardImageSelection | null>(null);
  const [acknowledged, setAcknowledged] = useState<ReadonlySet<number>>(() => new Set());
  const { lead, rest } = splitReview(data.review.filter(card => !acknowledged.has(card.number)));
  const running = new Set(data.running.map(card => card.project));
  const openCard = (number: number) => onOpenCard?.(number);
  const enlarge = (card: FrontPageCard, name: string) => setImage({ src: imageUrl(name), alt: card.title });
  const done = newestFirst(data.done);
  const pictured = done.filter(card => card.images.length > 0);
  const plain = done.filter(card => card.images.length === 0);
  const ids = useId();

  return <div className="v3-front-page" data-surface={photo ? "glass" : "paper"} data-testid="front-page">
    <header className="v3-front-gnb">
      <GlassBox glass={photo} className="v3-front-brand" capsule>
        <span>소울스트림</span>
      </GlassBox>
      <GlassBox glass={photo} className="v3-front-tabs" capsule>
        <DetailTabs<Tab> id={`${ids}-tab`} label="화면" panelId={`${ids}-panel`} variant="card" tabs={TABS} value={tab} onChange={setTab} />
      </GlassBox>
      <GlassBox glass={photo} className="v3-front-actions" capsule>
        <DashboardIconCap appearance="bare" label="검색" onClick={onOpenSearch}>
          <Search className="size-5" strokeWidth={1.4} absoluteStrokeWidth aria-hidden="true" />
        </DashboardIconCap>
        <ConfigButton variant="chrome" appearance="bare" onClick={() => onOpenConfig?.()} />
        <ThemeToggle variant="chrome" appearance="bare" />
        <DashboardIconCap appearance="bare" label="계정">
          <UserRound className="size-5" strokeWidth={1.4} absoluteStrokeWidth aria-hidden="true" />
        </DashboardIconCap>
      </GlassBox>
    </header>

    <div className="v3-front-masthead">
      <h1 className="v3-front-date"><time dateTime={isoDate(now, timeZone)}>{frontPageDate(now, timeZone)}</time></h1>
      <div className="v3-front-composer">{composer}</div>
    </div>

    <GlassBox glass={photo} className="v3-front-sheet" id={`${ids}-panel`} role="tabpanel" aria-labelledby={`${ids}-tab-front`}>
      <nav className="v3-front-projects" aria-label="오늘 움직인 프로젝트">
        {data.projectsToday.map(project => <button key={project} type="button" className="v3-front-project" onClick={() => onOpenProject?.(project)}>
          {projectIcon(project) ? <span aria-hidden="true">{projectIcon(project)}</span> : null}
          <span className="v3-front-project-name">{projectName(project)}</span>
          {running.has(project) ? <i className="v3-card-progress-dot v3-card-progress-dot--doing" role="img" aria-label="돌아가는 일 있음" /> : null}
        </button>)}
      </nav>

      <div className="v3-front-columns">
        <section className="v3-front-column v3-front-review" aria-labelledby={`${ids}-review`}>
          <h2 className="v3-front-head" id={`${ids}-review`}>볼 것</h2>
          {lead ? <LeadStory card={lead} timeZone={timeZone} imageUrl={imageUrl} onOpen={() => openCard(lead.number)}
            onEnlarge={name => enlarge(lead, name)}
            onAcknowledge={() => setAcknowledged(current => new Set(current).add(lead.number))} /> : null}
          <ul className="v3-front-list">
            {rest.map(card => <li key={card.number}>
              <button type="button" className="v3-front-row" onClick={() => openCard(card.number)}>
                <span className="v3-front-title">{card.title}</span>
                {card.ask ? <span className="v3-front-ask">{card.ask}</span> : null}
              </button>
            </li>)}
          </ul>
        </section>

        <section className="v3-front-column v3-front-running" aria-labelledby={`${ids}-running`}>
          <h2 className="v3-front-head" id={`${ids}-running`}>돌아가는 일</h2>
          <Ledger cards={newestFirst(data.running)} timeZone={timeZone} onOpen={openCard} />
          {data.blocked.length ? <>
            <h3 className="v3-front-subhead">막힌 일</h3>
            <Ledger cards={newestFirst(data.blocked)} timeZone={timeZone} onOpen={openCard} />
          </> : null}
        </section>

        <div className="v3-front-column v3-front-side v3-front-side--upper">
          <section aria-labelledby={`${ids}-questions`}>
            <h2 className="v3-front-head" id={`${ids}-questions`}>물어본 것</h2>
            <ul className="v3-front-list">
              {[...data.questions].sort((a, b) => Date.parse(b.askedAt) - Date.parse(a.askedAt)).slice(0, QUESTION_LIMIT)
                .map(question => <li key={question.number}><Question question={question} onOpen={() => openCard(question.number)} /></li>)}
            </ul>
          </section>
          <section aria-labelledby={`${ids}-machines`}>
            <h2 className="v3-front-head" id={`${ids}-machines`}>기계</h2>
            <Machines nodes={data.nodes} limits={data.limits} />
          </section>
        </div>
      </div>

      <div className="v3-front-columns v3-front-lower">
        <section className="v3-front-column v3-front-done" aria-labelledby={`${ids}-done`}>
          <h2 className="v3-front-head" id={`${ids}-done`}>끝난 일</h2>
          <ul className="v3-front-wall">
            {pictured.map(card => <li key={card.number}>
              <button type="button" className="v3-front-tile-image" aria-label={`${card.title} 그림 크게 보기`} onClick={() => enlarge(card, card.images[0]!)}>
                <img src={imageUrl(card.images[0]!)} alt="" loading="lazy" />
              </button>
              <button type="button" className="v3-front-tile-caption" onClick={() => openCard(card.number)}>
                <span className="v3-front-kicker">{projectName(card.project)}</span>
                <span className="v3-front-tile-title">{card.title}</span>
              </button>
            </li>)}
          </ul>
          <ul className="v3-front-list v3-front-index">
            {plain.map(card => <li key={card.number}>
              <button type="button" className="v3-front-index-row" onClick={() => openCard(card.number)}>
                <time className="v3-front-time" dateTime={card.statusChangedAt}>{clockTime(card.statusChangedAt, timeZone)}</time>
                <span className="v3-front-kicker">{projectName(card.project)}</span>
                <span className="v3-front-index-title">{card.title}</span>
              </button>
            </li>)}
          </ul>
        </section>

        <div className="v3-front-column v3-front-side v3-front-side--lower">
          <section aria-labelledby={`${ids}-queued`}>
            <h2 className="v3-front-head" id={`${ids}-queued`}>대기</h2>
            <ul className="v3-front-list">
              {data.queued.map(card => <li key={card.number}>
                <button type="button" className="v3-front-row v3-front-row--quiet" onClick={() => openCard(card.number)}>
                  <span className="v3-front-kicker">{projectName(card.project)}</span>
                  <span className="v3-front-index-title">{card.title}</span>
                </button>
              </li>)}
            </ul>
          </section>
          <section aria-labelledby={`${ids}-record`}>
            <h2 className="v3-front-head" id={`${ids}-record`}>기록</h2>
            <ul className="v3-front-list">
              {data.dailyPages.map(page => <li key={page}>
                <button type="button" className="v3-front-row v3-front-row--quiet">
                  <span className="v3-front-index-title">{page}</span>
                </button>
              </li>)}
            </ul>
          </section>
        </div>
      </div>
    </GlassBox>

    <CardImageViewer image={image} onClose={() => setImage(null)} />
  </div>;
}

/** 사진 배경에서는 유리, 종이 배경에서는 바탕 없는 같은 상자. */
function GlassBox({ glass, capsule = false, className, children, ...props }: {
  glass: boolean; capsule?: boolean; className: string; children: ReactNode; id?: string; role?: string; "aria-labelledby"?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const webglActive = useGlassSurface(ref, { enabled: glass });
  useLiquidLens(ref, { scale: 18, enabled: glass && capsule && !webglActive });
  return <div {...props} ref={ref}
    className={cn(className, glass && "border border-glass-border glass-strong glass-chrome lg-rim", glass && capsule && "dashboard-toolbar-cap")}
    data-liquid-glass-webgl={webglActive ? "true" : undefined}>
    {children}
  </div>;
}

function LeadStory({ card, timeZone, imageUrl, onOpen, onEnlarge, onAcknowledge }: {
  card: FrontPageCard; timeZone?: string; imageUrl(name: string): string;
  onOpen(): void; onEnlarge(name: string): void; onAcknowledge(): void;
}) {
  const cover = card.images[0];
  return <article className="v3-front-lead">
    {cover ? <button type="button" className="v3-front-lead-cover" aria-label={`${card.title} 그림 크게 보기`} onClick={() => onEnlarge(cover)}>
      <img src={imageUrl(cover)} alt="" />
    </button> : null}
    <button type="button" className="v3-front-lead-text" onClick={onOpen}>
      <span className="v3-front-kicker">
        <span>{projectName(card.project)}</span>
        <time className="v3-front-time" dateTime={card.statusChangedAt}>{clockTime(card.statusChangedAt, timeZone)}</time>
      </span>
      <span className="v3-front-lead-title">{card.title}</span>
      {card.ask ? <span className="v3-front-lead-ask">{card.ask}</span> : null}
    </button>
    <div className="v3-front-lead-foot">
      <CardProgressSummary summary={summarizeCardItems(toCheckItems(card))} />
      <Button variant="outline" onClick={onAcknowledge}>확인했어</Button>
    </div>
  </article>;
}

function Ledger({ cards, timeZone, onOpen }: { cards: readonly FrontPageCard[]; timeZone?: string; onOpen(number: number): void }) {
  const [open, setOpen] = useState<number | null>(null);
  return <ul className="v3-front-list">
    {cards.map(card => {
      const expanded = open === card.number;
      const itemsId = `front-ledger-${card.number}`;
      return <li key={card.number} className="v3-front-ledger-row">
        <time className="v3-front-time" dateTime={card.statusChangedAt}>{clockTime(card.statusChangedAt, timeZone)}</time>
        <button type="button" className="v3-front-ledger-main" onClick={() => onOpen(card.number)}>
          <span className="v3-front-kicker">{projectName(card.project)}</span>
          <span className="v3-front-title">{card.title}</span>
          {card.now ? <span className="v3-front-now">{card.now}</span> : null}
        </button>
        {card.items.length ? <DashboardIconCap size="small" appearance="bare" className="v3-front-expand"
          label={expanded ? "접기" : "펼쳐보기"} aria-expanded={expanded} aria-controls={itemsId}
          onClick={() => setOpen(expanded ? null : card.number)}>
          {expanded
            ? <Minus className="size-4" strokeWidth={1.4} absoluteStrokeWidth aria-hidden="true" />
            : <Plus className="size-4" strokeWidth={1.4} absoluteStrokeWidth aria-hidden="true" />}
        </DashboardIconCap> : null}
        {expanded ? <ul className="v3-front-ledger-items" id={itemsId}>
          {toCheckItems(card).map(item => <li key={item.id} data-display={item.display}>
            <i className={`v3-card-progress-dot v3-card-progress-dot--${item.display}`} aria-hidden="true" />
            <span>{item.title}</span>
          </li>)}
        </ul> : null}
      </li>;
    })}
  </ul>;
}

function Question({ question, onOpen }: { question: FrontPageQuestion; onOpen(): void }) {
  const [chosen, setChosen] = useState<string | null>(null);
  return <article className="v3-front-question">
    <button type="button" className="v3-front-question-text" onClick={onOpen}>
      <span className="v3-front-kicker v3-front-kicker--quiet">{question.cardTitle}</span>
      <span className="v3-front-question-body">{question.text}</span>
    </button>
    <div className="v3-front-question-options" role="group" aria-label="답 고르기">
      {question.options.map(option => <Button key={option} variant={chosen === option ? "default" : "outline"}
        aria-pressed={chosen === option} disabled={chosen !== null && chosen !== option}
        onClick={() => setChosen(current => current === option ? null : option)}>{option}</Button>)}
    </div>
  </article>;
}

function Meter({ label, value, warning }: { label: string; value: number; warning: boolean }) {
  const clamped = Math.max(0, Math.min(100, value));
  return <span className={cn("persistent-session-weekly-usage-track v3-front-meter", warning && "is-warning")}
    role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(clamped)}>
    <i style={{ width: `${clamped}%` }} />
  </span>;
}

function Machines({ nodes, limits }: { nodes: readonly FrontPageNode[]; limits: readonly FrontPageLimit[] }) {
  return <div className="v3-front-machines">
    <div className="v3-front-machine v3-front-machine-legend" aria-hidden="true">
      <span />
      <span>CPU</span><span>메모리</span><span>디스크</span>
    </div>
    {nodes.map(node => <div key={node.id} className="v3-front-machine" title={node.id}>
      <span className="v3-front-machine-name">{node.label}</span>
      <Meter label={`${node.label} CPU`} value={node.cpu} warning={node.cpu >= NODE_USAGE_WARNING} />
      <Meter label={`${node.label} 메모리`} value={node.mem} warning={node.mem >= NODE_USAGE_WARNING} />
      <Meter label={`${node.label} 디스크`} value={node.disk} warning={node.disk >= NODE_USAGE_WARNING} />
    </div>)}
    <div className="v3-front-limits">
      {limits.map(limit => <div key={limit.name} className="v3-front-machine v3-front-limit">
        <span className="v3-front-machine-name">{limit.name}</span>
        {limit.rejected
          ? <span className="v3-front-limit-rejected">한도 거부</span>
          : <Meter label={`${limit.name} 남은 한도`} value={limit.remaining} warning={limit.remaining < LIMIT_REMAINING_WARNING} />}
      </div>)}
    </div>
  </div>;
}
