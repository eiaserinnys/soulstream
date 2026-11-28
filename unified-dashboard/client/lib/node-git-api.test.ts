import { createI18n } from "@soulstream/i18n";
import { expect, it } from "vitest";
import { nodeGitErrorText, type NodeGitField } from "./node-git-api";

it("falls back to the generic error for an unrecognized field", () => {
  const { t } = createI18n("en");
  for (const field of ["unrecognized_field", "constructor"]) {
    expect(nodeGitErrorText({ code: "invalid_request", field: field as NodeGitField }, t))
      .toBe("Git request failed.");
  }
});
