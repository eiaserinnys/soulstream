import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { CardBoard, boardColumns } from "./CardBoard";
import { reviewCard } from "./components-review-fixtures";

it("keeps seven columns in order and hides done and cancelled together", () => {
  const cards = [...boardColumns.map(({status}) => ({...reviewCard,id:status,status})),
    {...reviewCard,id:"archived",archived:true}];
  const render = (includeCompleted?: boolean) => renderToStaticMarkup(createElement(CardBoard, {
    cards, renderCard: card => createElement("span", {"data-sample":card.id}, card.id),
    completion: includeCompleted === undefined ? undefined : {includeCompleted,onChange:()=>undefined},
  }));
  const full = render();
  expect([...full.matchAll(/data-board-column="([^"]+)"/g)].map(match => match[1])).toEqual(["todo","queued","running","blocked","review","done","cancelled"]);
  expect(full).toContain("드래프트"); expect(full).toContain("검수 대기");
  expect(full).toContain('data-sample="cancelled"'); expect(full).not.toContain('data-sample="archived"');
  expect(render(false)).not.toContain('data-board-column="done"'); expect(render(false)).not.toContain('data-sample="done"');
  expect(render(false)).not.toContain('data-board-column="cancelled"'); expect(render(false)).not.toContain('data-sample="cancelled"');
  expect(render(true)).toContain('data-sample="cancelled"'); expect(render(true)).toContain('data-sample="done"'); expect(full).toContain('data-sample="done"');
});

for (const count of [0, 2]) it(`keeps the draft creation action after the title and count (${count} drafts)`, () => {
  const html = renderToStaticMarkup(createElement(CardBoard, {
    cards: Array.from({length: count}, (_, index) => ({...reviewCard, id: `draft-${index}`, status: "todo" as const})),
    renderCard: card => createElement("span", null, card.title),
    draftAction: createElement("button", {"aria-label": "새 카드"}, "+"),
  }));
  expect(html).toMatch(new RegExp(`<h3>드래프트</h3><span>${count}개</span><button aria-label="새 카드">\\+</button></div>`));
});

it("hides empty lanes after applying the completed filter when requested", () => {
  const cards = [
    {...reviewCard,id:"draft",status:"todo" as const},
    {...reviewCard,id:"running",status:"running" as const},
    {...reviewCard,id:"done",status:"done" as const},
    {...reviewCard,id:"cancelled",status:"cancelled" as const},
    {...reviewCard,id:"archived",status:"queued" as const,archived:true},
  ];
  const render = (includeCompleted:boolean) => renderToStaticMarkup(createElement(CardBoard, {
    cards, renderCard: card => createElement("span", {"data-sample":card.id}, card.id),
    completion: {includeCompleted,onChange:()=>undefined}, hideEmptyLanes:true,
  }));
  const visible = render(false);
  expect([...visible.matchAll(/data-board-column="([^"]+)"/g)].map(match=>match[1])).toEqual(["todo","running"]);
  expect(visible).not.toContain('data-sample="archived"');
  const completed = render(true);
  expect([...completed.matchAll(/data-board-column="([^"]+)"/g)].map(match=>match[1])).toEqual(["todo","running","done","cancelled"]);
});

it("shows one empty-board message when every lane is hidden", () => {
  const html = renderToStaticMarkup(createElement(CardBoard, {
    cards:[], renderCard:()=>null, hideEmptyLanes:true,
  }));
  expect([...html.matchAll(/class="v3-card-board-empty"/g)]).toHaveLength(1);
  expect(html).toContain("카드가 없습니다");
  expect(html).not.toMatch(/data-board-column=/);
});
