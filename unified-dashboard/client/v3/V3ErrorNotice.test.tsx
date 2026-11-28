import { readFileSync } from "node:fs";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { V3ErrorNotice } from "./V3ErrorNotice";

describe("V3ErrorNotice", () => {
  it("shows original diagnostics and an outline retry only when provided", () => {
    const html = renderToStaticMarkup(
      <V3ErrorNotice
        message="폴더 보드를 열지 못했습니다."
        detail="HTTP 503 Authorization: Bearer synthetic-private-value"
        onRetry={() => {}}
      />,
    );

    expect(html).toContain("폴더 보드를 열지 못했습니다.");
    expect(html).toContain("<details");
    expect(html).toContain("기술 상세");
    expect(html).toContain("503");
    expect(html).toContain("synthetic-private-value");
    expect(html).not.toContain("입력 내용과 연결 상태를 확인한 뒤 다시 시도하세요.");
    expect(html).toContain("다시 불러오기");
    expect(html).toContain("border");
    expect(html).not.toContain("<details open");
    expect(renderToStaticMarkup(<V3ErrorNotice message="실패" detail="실패"/>)).not.toContain("기술 상세");
    expect(renderToStaticMarkup(<V3ErrorNotice message="실패"/>)).not.toContain("기술 상세");
  });

  it("keeps Korean words whole while still allowing long tokens to wrap", () => {
    const css = readFileSync(new URL("./v3-content-boundary.css", import.meta.url), "utf8");

    expect(css).toMatch(/\.v3-error-notice\s*\{[^}]*word-break:\s*var\(--locale-word-break,\s*keep-all\);[^}]*overflow-wrap:\s*anywhere;/s);
  });
});
