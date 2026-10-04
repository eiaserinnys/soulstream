import { expect, it, vi } from "vitest";
import { performCardTransition } from "./card-status-coordinator";
import { reviewCard } from "./components-review-fixtures";

it("running intent reaches execution even when the card is already running", async () => {
  const card = {...reviewCard, status:"running" as const};
  const change = vi.fn();
  const detail = {card,reports:[],questions:[],sessions:[],comments:[]};
  await performCardTransition({pending:false,load:async()=>detail,change},"running");
  expect(change).toHaveBeenCalledWith(card,"running",undefined);
});
