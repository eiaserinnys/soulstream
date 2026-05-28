import { describe, expect, it } from "vitest";

import { buildSoulstreamPrompt } from "./prompt.js";
import type { PageActionPayload } from "./schema.js";

const basePayload: PageActionPayload = {
  action: "reference_digest",
  url: "https://example.com/post",
  title: "Example Post",
  selectionText: "selected quote",
  metaDescription: "meta summary",
  bodyText: "body text",
  bodyTruncated: false,
  bodyCharLimit: 12_000,
  extractionStatus: "complete",
  source: "content-script",
};

describe("buildSoulstreamPrompt", () => {
  it("serializes action, page metadata, selection, and body candidate", () => {
    const prompt = buildSoulstreamPrompt(basePayload);

    expect(prompt).toContain("작업: 레퍼런스 정리 + 다이제스트 포스트하기");
    expect(prompt).toContain("- URL: https://example.com/post");
    expect(prompt).toContain("## 선택 영역\n\nselected quote");
    expect(prompt).toContain("## 본문 후보\n\nbody text");
  });

  it("makes truncation and extraction failures explicit", () => {
    const prompt = buildSoulstreamPrompt({
      ...basePayload,
      bodyTruncated: true,
      extractionStatus: "fallback",
      extractionError: "Cannot access this page",
    });

    expect(prompt).toContain("본문 후보 (truncated at 12000 chars)");
    expect(prompt).toContain("- Extraction: fallback: Cannot access this page");
  });
});
