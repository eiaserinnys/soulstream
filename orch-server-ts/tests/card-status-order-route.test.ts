import { expect, it, vi } from "vitest";
import { listCardRouteBody } from "../src/cards/card_route_body.js";

const service = () => ({
  listCards: vi.fn(async () => []),
  listPagedCards: vi.fn(async () => ({ cards: [], nextCursor: null })),
  projectCards: vi.fn(async (cards: unknown[]) => cards),
});
const options = (card: ReturnType<typeof service>) => ({
  cardServiceProvider: async () => card, provider: { listFolders: async () => [] },
}) as never;
const open = () => ({ restricted: false, allowedFolderIds: [] }) as never;

it("REST 비페이지 카드 목록은 상태 변경순을 고르고 페이지 목록은 자기 정렬을 쓴다", async () => {
  const card = service();
  await listCardRouteBody(options(card), {}, open);
  expect(card.listCards).toHaveBeenCalledWith(expect.objectContaining({ order: "status_changed" }));
  await listCardRouteBody(options(card), { limit: "10" }, open);
  expect(card.listPagedCards).toHaveBeenCalledTimes(1);
  expect(card.listCards).toHaveBeenCalledTimes(1);
});
