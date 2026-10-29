import { useId, useState, type ReactNode } from "react";
import { Button, DashboardIconCap, useDashboardStore } from "@seosoyoung/soul-ui";
import { Minus, Plus } from "lucide-react";
import { CardImageViewer, type CardImageSelection } from "./CardImageViewer";
import { CardProgressSummary } from "./CardProgressSummary";
import { summarizeCardItems } from "./card-item-summary";
import { FrontPageGnb, GlassBox, Machines, type FrontTab } from "./front-page-parts";
import {
  clockTime, frontPageDate, isoDate, newestFirst, projectIcon, projectName, splitReview, toCheckItems,
  type FrontPageCard, type FrontPageData, type FrontPageQuestion,
} from "./front-page-model";

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
  const [tab, setTab] = useState<FrontTab>("front");
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
    <FrontPageGnb glass={photo} idPrefix={`${ids}-tab`} panelId={`${ids}-panel`} tab={tab} onTab={setTab}
      onOpenSearch={onOpenSearch} onOpenConfig={onOpenConfig} />

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
