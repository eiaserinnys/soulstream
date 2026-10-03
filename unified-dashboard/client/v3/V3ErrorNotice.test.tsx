import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { V3ErrorNotice } from "./V3ErrorNotice";

describe("V3ErrorNotice", () => {
  it("leads with a short user message and keeps only safe diagnostics collapsed", () => {
    const html = renderToStaticMarkup(
      <V3ErrorNotice
        message="폴더 보드를 열지 못했습니다."
        detail="HTTP 503 Authorization: Bearer synthetic-private-value"
      />,
    );

    expect(html).toContain("폴더 보드를 열지 못했습니다.");
    expect(html).toContain("<details");
    expect(html).toContain("기술 상세");
    expect(html).toContain("503");
    expect(html).not.toContain("synthetic-private-value");
    expect(html).toContain("확인");
    expect(html).not.toContain("<details open");
  });
});
