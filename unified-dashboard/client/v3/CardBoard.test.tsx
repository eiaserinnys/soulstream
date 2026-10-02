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
