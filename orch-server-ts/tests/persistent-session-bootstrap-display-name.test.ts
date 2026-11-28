import { expect, it } from "vitest";

import { bootstrapDisplayName } from "../src/session/persistent_session_bootstrap.js";

it.each([
  ["ソ・ソヨン(PAS)", "ソ・ソヨン"],
  ["서소영 (PAS)", "서소영"],
  ["Seo Soyoung (PAS)", "Seo Soyoung"],
  ["(PAS)", "PAS"],
  ["ワークスペース", "ワークスペース"],
  [undefined, "PAS"],
])("bootstrapDisplayName(%j) returns %s", (profileName, expected) => {
  expect(bootstrapDisplayName(profileName)).toBe(expected);
});
