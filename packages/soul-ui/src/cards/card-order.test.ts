import { expect, it } from "vitest";
import { sortByStatusChange, sortCardsInStatus } from "./card-order";

const card = (id: string, status: string, statusChangedAt: string | null, queuePositionKey: string | null = null) =>
  ({ id, status, statusChangedAt, updatedAt: "2026-01-01T00:00:00Z", queuePositionKey });

it("상태 변경순은 최근 변경이 먼저이고 값이 없으면 updatedAt, 같으면 id 내림차순이다", () => {
  const cards = [
    card("a", "review", "2026-02-01T00:00:00Z"),
    card("b", "review", "2026-03-01T00:00:00Z"),
    card("c", "review", null),
    card("d", "review", "2026-02-01T00:00:00Z"),
  ];
  expect(sortByStatusChange(cards).map(c => c.id)).toEqual(["b", "d", "a", "c"]);
});

it("칸 안에서 queued만 대기열 키 오름차순이고 나머지는 상태 변경순이다", () => {
  const queued = [card("x", "queued", "2026-05-01T00:00:00Z", "b"), card("y", "queued", "2026-01-05T00:00:00Z", "a")];
  expect(sortCardsInStatus(queued).map(c => c.id)).toEqual(["y", "x"]);
  const running = [card("p", "running", "2026-01-05T00:00:00Z"), card("q", "running", "2026-05-01T00:00:00Z")];
  expect(sortCardsInStatus(running).map(c => c.id)).toEqual(["q", "p"]);
});
