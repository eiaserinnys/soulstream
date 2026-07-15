import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { V3ErrorNotice } from "./V3ErrorNotice";

describe("V3ErrorNotice", () => {
  it("leads with a short user message and keeps raw detail collapsed", () => {
    const html = renderToStaticMarkup(
      <V3ErrorNotice
        message="업무 보드를 열지 못했습니다."
        detail="PostgreSQL connection refused at internal-host:5432"
      />,
    );

    expect(html).toContain("업무 보드를 열지 못했습니다.");
    expect(html).toContain("<details");
    expect(html).toContain("세부 정보");
    expect(html).toContain("PostgreSQL connection refused at internal-host:5432");
    expect(html).not.toContain("<details open");
  });
});
