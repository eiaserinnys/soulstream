import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { CardBoard, boardColumns } from "./CardBoard";
import { reviewCard } from "./components-review-fixtures";

it("keeps six columns in order, excludes archived and cancelled, and hides only done in folders", () => {
  const cards = [...boardColumns.map(({status}) => ({...reviewCard,id:status,status})),
    {...reviewCard,id:"cancelled",status:"cancelled" as const}, {...reviewCard,id:"archived",archived:true}];
  const render = (includeCompleted?: boolean) => renderToStaticMarkup(createElement(CardBoard, {
    cards, renderCard: card => createElement("span", {"data-sample":card.id}, card.id),
    completion: includeCompleted === undefined ? undefined : {includeCompleted,onChange:()=>undefined},
  }));
  const full = render();
  expect([...full.matchAll(/data-board-column="([^"]+)"/g)].map(match => match[1])).toEqual(["todo","queued","running","blocked","review","done"]);
  expect(full).toContain("드래프트"); expect(full).toContain("검수 대기");
  expect(full).not.toContain('data-sample="cancelled"'); expect(full).not.toContain('data-sample="archived"');
  expect(render(false)).not.toContain('data-board-column="done"'); expect(render(false)).not.toContain('data-sample="done"');
  expect(render(true)).toContain('data-sample="done"'); expect(full).toContain('data-sample="done"');
});

for (const count of [0, 2]) it(`keeps the draft creation action after the title and count (${count} drafts)`, () => {
  const html = renderToStaticMarkup(createElement(CardBoard, {
    cards: Array.from({length: count}, (_, index) => ({...reviewCard, id: `draft-${index}`, status: "todo" as const})),
    renderCard: card => createElement("span", null, card.title),
    draftAction: createElement("button", {"aria-label": "새 카드"}, "+"),
  }));
  expect(html).toMatch(new RegExp(`<h3>드래프트</h3><span>${count}개</span><button aria-label="새 카드">\\+</button></div>`));
});
