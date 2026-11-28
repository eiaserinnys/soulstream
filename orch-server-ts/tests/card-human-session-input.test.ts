import { expect, it, vi } from "vitest";
import { CardVersionConflict } from "../src/cards/control_plane/card_models.js";
import { recordDirectHumanSessionInput } from "../src/cards/card_human_session_input.js";

it("ignores whitespace-only direct input", async () => {
  const cards = {
    getAssignedCardContext: vi.fn(async () => ({ cards: [{ id: "card" }] })),
    getDirectInputCardId: vi.fn(async () => "card"),
    getCard: vi.fn(async () => ({ card: { id: "card", version: 1, archived: false, assignee_kind: "session", assignee_session_id: "owner" } })),
    addComment: vi.fn(async () => ({})),
  };
  await recordDirectHumanSessionInput(cards as never, "owner", "  \n ", { source: "browser", user_id: "a@b" });
  expect(cards.addComment).not.toHaveBeenCalled();
});

it("re-reads the card after one version conflict", async () => {
  const row = { id: "card", version: 1, archived: false, assignee_kind: "session", assignee_session_id: "owner" };
  const addComment = vi.fn().mockRejectedValueOnce(new CardVersionConflict("card", "card", 1, 2)).mockResolvedValue({});
  const getCard = vi.fn().mockResolvedValueOnce({ card: row }).mockResolvedValueOnce({ card: { ...row, version: 2 } });
  const cards = { getDirectInputCardId: vi.fn(async () => "card"), getCard, addComment };
  await recordDirectHumanSessionInput(cards as never, "owner", "  원문  ", { source: "browser", user_id: "a@b" });
  expect(addComment).toHaveBeenCalledTimes(2);
  expect(addComment).toHaveBeenLastCalledWith(expect.objectContaining({ body: "  원문  ", expectedVersion: 2, alreadyDelivered: true }));
});
