import { DashboardIconCap } from "@seosoyoung/soul-ui";
import { X } from "lucide-react";

export interface TaskDrawerCard {
  id: string;
  number: number;
  title: string;
  meta: string;
}

export interface TaskDrawerGroup {
  id: string;
  label: string;
  count: number;
  cards: TaskDrawerCard[];
}

export function PasSplitTaskDrawer({ groups, onClose }: { groups: TaskDrawerGroup[]; onClose(): void }) {
  return <aside className="persistent-session-tasks pas-split-drawer" aria-label="작업" data-testid="pas-task-drawer">
    <div className="persistent-session-task-head">
      <h2>작업</h2>
      <DashboardIconCap appearance="bare" label="작업 목록 닫기" onClick={onClose}>
        <X className="size-5" strokeWidth={1.4} absoluteStrokeWidth aria-hidden="true"/>
      </DashboardIconCap>
    </div>
    <div className="persistent-session-task-scroll pas-split-drawer-scroll">
      {groups.map(group => <section className="pas-task-group" key={group.id} data-task-group={group.id}>
        <header className="pas-task-group-head">
          <h3>{group.label}</h3>
          <span className="pas-task-group-count">{group.count}개</span>
        </header>
        {group.cards.length > 0 ? <ul className="pas-task-list">
          {group.cards.map(card => <li className="pas-task-row" key={card.id}>
            <span className="pas-task-number">#{card.number}</span>
            <span className="pas-task-title">{card.title}</span>
            <span className="pas-task-meta">{card.meta}</span>
          </li>)}
        </ul> : <p className="pas-task-empty">이 그룹에 표시할 카드가 없습니다.</p>}
      </section>)}
    </div>
  </aside>;
}
