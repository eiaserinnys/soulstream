import { afterEach, expect, it } from "vitest";
import { useCardNavigation } from "./card-navigation";

afterEach(() => useCardNavigation.getState().close());

it("feed initial session is one-shot navigation state cleared by regular card open and close", () => {
  const navigation = useCardNavigation.getState();
  navigation.open("feed-card", "overlay", null, "feed-session");
  expect(useCardNavigation.getState()).toMatchObject({ cardId: "feed-card", initialSessionId: "feed-session" });

  useCardNavigation.getState().open("row-card", "overlay");
  expect(useCardNavigation.getState()).toMatchObject({ cardId: "row-card", initialSessionId: null });

  useCardNavigation.getState().open("feed-card", "overlay", null, "feed-session");
  useCardNavigation.getState().close();
  expect(useCardNavigation.getState()).toMatchObject({ cardId: null, initialSessionId: null });
});
