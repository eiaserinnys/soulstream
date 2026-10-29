import { useId, useState, type ReactNode } from "react";
import { Button } from "@seosoyoung/soul-ui";
import { CardImageViewer, type CardImageSelection } from "./CardImageViewer";
import { CardProgressSummary } from "./CardProgressSummary";
import { FrontRow, FrontRowGroup, rowLeaveDelay } from "./FrontRow";
import { summarizeCardItems } from "./card-item-summary";
import { FrontPageGnb, Machines, type FrontTab } from "./front-page-parts";
import {
  frontPageDate, isoDate, ledgerStamp, newestFirst, projectName, toCheckItems,
  type FrontPageCard, type FrontPageData, type FrontPageQuestion,
} from "./front-page-model";
import "./v3-front-index.css";

interface Props {
  data: FrontPageData;
  now: Date;
  timeZone?: string;
  imageUrl(name: string): string;
  /** 화면 아래 대화창(FrontDock). */
  dock: ReactNode;
  onOpenCard?(number: number): void;
  onOpenSearch?(): void;
  onOpenConfig?(): void;
}

/**
 * 소울스트림 1면(Index 결). 위에서부터 볼 것과 물어본 것, 막힘, 실행 중 순으로 둔다.
 * 순위는 위치와 차지하는 넓이로 말한다. 행은 접혀 있고 머물거나 누르면 아래를 덮으며 열린다.
 */
export function FrontPageIndex({ data, now, timeZone, imageUrl, dock, onOpenCard, onOpenSearch, onOpenConfig }: Props) {
  const ids = useId();
  const [tab, setTab] = useState<FrontTab>("front");
  const [image, setImage] = useState<CardImageSelection | null>(null);
  const [acknowledged, setAcknowledged] = useState<ReadonlySet<number>>(() => new Set());
  const [leaving, setLeaving] = useState<ReadonlySet<number>>(() => new Set());
  const stamp = (iso: string) => <time dateTime={iso}>{ledgerStamp(iso, now, timeZone)}</time>;
  const review = newestFirst(data.review).filter(card => !acknowledged.has(card.number));
  const questions = [...data.questions].sort((a, b) => Date.parse(b.askedAt) - Date.parse(a.askedAt));
  const pictured = newestFirst(data.done).filter(card => card.images.length > 0);

  const acknowledge = (number: number) => {
    setLeaving(current => new Set(current).add(number));
    window.setTimeout(() => {
      setAcknowledged(current => new Set(current).add(number));
      setLeaving(current => { const next = new Set(current); next.delete(number); return next; });
    }, rowLeaveDelay());
  };

  return <div className="v3-front-page fi-page" data-surface="paper" data-testid="front-page-index">
    <FrontPageGnb glass={false} idPrefix={`${ids}-tab`} panelId={`${ids}-panel`} tab={tab} onTab={setTab}
      onOpenSearch={onOpenSearch} onOpenConfig={onOpenConfig} />
    <div className="fi-masthead">
      <h1 className="v3-front-date"><time dateTime={isoDate(now, timeZone)}>{frontPageDate(now, timeZone)}</time></h1>
    </div>

    <div className="fi-body" id={`${ids}-panel`} role="tabpanel" aria-labelledby={`${ids}-tab-front`}>
      <div className="fi-split">
        <section className="fi-column" aria-labelledby={`${ids}-review`}>
          <h2 className="v3-front-head" id={`${ids}-review`}>볼 것</h2>
          <FrontRowGroup>
            {review.map(card => <FrontRow key={card.number} rowKey={`review-${card.number}`}
              stamp={stamp(card.statusChangedAt)}
              line1={card.title}
              line2={<><span className="fi-kicker">{projectName(card.project)}</span>{card.ask ? <span className="fi-quiet">{card.ask}</span> : null}</>}
              extra={<ReviewExtra card={card} imageUrl={imageUrl}
                onEnlarge={name => setImage({ src: imageUrl(name), alt: card.title })}
                onOpen={() => onOpenCard?.(card.number)} onAcknowledge={() => acknowledge(card.number)} />}
              leaving={leaving.has(card.number)}
              onActivate={() => onOpenCard?.(card.number)} />)}
          </FrontRowGroup>
        </section>
        <section className="fi-column" aria-labelledby={`${ids}-questions`}>
          <h2 className="v3-front-head" id={`${ids}-questions`}>물어본 것</h2>
          <FrontRowGroup>
            {questions.map(question => <FrontRow key={question.number} rowKey={`question-${question.number}`}
              stamp={stamp(question.askedAt)}
              line1={question.text}
              line2={<span className="fi-quiet fi-meta">{question.cardTitle}</span>}
              extra={<QuestionExtra question={question} />}
              onActivate={() => onOpenCard?.(question.number)} />)}
          </FrontRowGroup>
        </section>
      </div>

      {data.blocked.length ? <section className="fi-blocked" aria-labelledby={`${ids}-blocked`}>
        <h2 className="v3-front-head" id={`${ids}-blocked`}>막힘</h2>
        <FrontRowGroup className="fi-rows--grid">
          {newestFirst(data.blocked).map(card => <FrontRow key={card.number} rowKey={`blocked-${card.number}`}
            stamp={stamp(card.statusChangedAt)}
            line1={card.title}
            line2={<><span className="fi-kicker">{projectName(card.project)}</span>{card.now ? <span className="fi-quiet">{card.now}</span> : null}</>}
            onActivate={() => onOpenCard?.(card.number)} />)}
        </FrontRowGroup>
      </section> : null}

      <section className="fi-running" aria-labelledby={`${ids}-running`}>
        <h2 className="v3-front-head" id={`${ids}-running`}>실행 중</h2>
        <FrontRowGroup className="fi-rows--grid">
          {newestFirst(data.running).map(card => <FrontRow key={card.number} rowKey={`running-${card.number}`}
            stamp={stamp(card.statusChangedAt)}
            line1={<><span className="fi-kicker">{projectName(card.project)}</span><span className="fi-title">{card.title}</span></>}
            extra={card.now ? <p className="fi-now">{card.now}</p> : undefined}
            onActivate={() => onOpenCard?.(card.number)} />)}
        </FrontRowGroup>
      </section>

      <div className="fi-split fi-last">
        <section className="fi-column" aria-labelledby={`${ids}-done`}>
          <h2 className="v3-front-head" id={`${ids}-done`}>끝난 일</h2>
          <ul className="fi-wall">
            {pictured.map(card => <li key={card.number}>
              <button type="button" className="fi-wall-image" aria-label={`${card.title} 그림 크게 보기`}
                onClick={() => setImage({ src: imageUrl(card.images[0]!), alt: card.title })}>
                <img src={imageUrl(card.images[0]!)} alt="" loading="lazy" />
              </button>
              <button type="button" className="fi-wall-caption" onClick={() => onOpenCard?.(card.number)}>
                <span className="fi-kicker">{projectName(card.project)}</span>
                <span className="fi-title">{card.title}</span>
              </button>
            </li>)}
          </ul>
        </section>
        <section className="fi-column" aria-labelledby={`${ids}-machines`}>
          <h2 className="v3-front-head" id={`${ids}-machines`}>기계</h2>
          <Machines nodes={data.nodes} limits={data.limits} />
        </section>
      </div>
    </div>

    <div className="fi-dock-seat">{dock}</div>
    <CardImageViewer image={image} onClose={() => setImage(null)} />
  </div>;
}

function ReviewExtra({ card, imageUrl, onEnlarge, onOpen, onAcknowledge }: {
  card: FrontPageCard; imageUrl(name: string): string; onEnlarge(name: string): void; onOpen(): void; onAcknowledge(): void;
}) {
  const cover = card.images[0];
  return <div className="fi-review-extra" data-cover={cover ? "true" : undefined}>
    {cover ? <button type="button" className="fi-cover" aria-label={`${card.title} 그림 크게 보기`} onClick={() => onEnlarge(cover)}>
      <img src={imageUrl(cover)} alt="" loading="lazy" />
    </button> : null}
    <div className="fi-review-foot">
      <CardProgressSummary summary={summarizeCardItems(toCheckItems(card))} />
      <div className="fi-actions">
        <Button variant="outline" onClick={onOpen}>카드 열기</Button>
        <Button variant="outline" onClick={onAcknowledge}>확인했어</Button>
      </div>
    </div>
  </div>;
}

function QuestionExtra({ question }: { question: FrontPageQuestion }) {
  const [chosen, setChosen] = useState<string | null>(null);
  return <div className="fi-actions fi-actions--start" role="group" aria-label="답 고르기">
    {question.options.map(option => <Button key={option} variant={chosen === option ? "default" : "outline"}
      aria-pressed={chosen === option} disabled={chosen !== null && chosen !== option}
      onClick={() => setChosen(current => current === option ? null : option)}>{option}</Button>)}
  </div>;
}
