/**
 * SessionMetadata 렌더링 회귀 테스트.
 *
 * node 환경에서 jsdom 없이 renderToStaticMarkup으로 렌더 경계의 크래시만 검증한다.
 */

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { MetadataEntry } from "@shared/types";
import { SessionMetadata } from "./SessionMetadata";

const render = (metadata: MetadataEntry[]): string =>
  renderToStaticMarkup(createElement(SessionMetadata, { metadata }));

describe("SessionMetadata", () => {
  it("type이 누락된 string value metadata entry를 안전하게 렌더링한다", () => {
    const metadata = [{ value: "x" } as MetadataEntry];

    expect(() => render(metadata)).not.toThrow();
    expect(render(metadata)).toContain("x");
  });

  it("git_commit metadata entry는 기존처럼 7글자 short value를 표시한다", () => {
    const metadata = [{ type: "git_commit", value: "abcdef1234567890" }];

    const html = render(metadata);

    expect(html).toContain("abcdef1");
    expect(html).toContain("abcdef1234567890");
  });
});
