import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { useCardStore } from "@seosoyoung/soul-ui/cards/card-store";
import { CardInbox } from "./CardInbox";
import type { CardRow } from "@seosoyoung/soul-ui/cards/card-types";
vi.mock("./CardRow", () => ({ CardRow: () => createElement("div", null, "card") }));
vi.mock("@seosoyoung/soul-ui/cards/CardQueue", () => ({ CardQueue: () => null }));
vi.mock("@seosoyoung/soul-ui/cards/card-store", async importOriginal => {
 const actual = await importOriginal<typeof import("@seosoyoung/soul-ui/cards/card-store")>();
 return {useCardStore: Object.assign((selector: (state: ReturnType<typeof actual.useCardStore.getState>) => unknown) => selector(actual.useCardStore.getState()), actual.useCardStore)};
});
afterEach(() => useCardStore.getState().reset());
it("renders one empty state without empty group DOM", () => {
 const html = renderToStaticMarkup(createElement(CardInbox, { folders: [] }));
 expect(html).toContain("지금은 확인할 것이 없습니다");
 expect(html).not.toContain("data-card-group");
});
it("renders only populated groups in attention, running, queued order", () => {
 useCardStore.getState().putCards([{
  id: "review", status: "review", archived: false, positionKey: "a"
 } as CardRow, { id: "run", status: "running", archived: false, positionKey: "b" } as CardRow]);
 const html = renderToStaticMarkup(createElement(CardInbox, { folders: [] }));
 expect(html).not.toContain('data-card-group="queued"');
 expect(html.indexOf('data-card-group="attention"')).toBeLessThan(html.indexOf('data-card-group="running"'));
 expect(html).not.toContain("카드가 없습니다");
});
