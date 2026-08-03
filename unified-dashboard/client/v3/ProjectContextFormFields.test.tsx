import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ProjectAtomFields } from "./ProjectContextFormFields";

describe("ProjectAtomFields", () => {
  it("exposes an optional positive limit and keeps the default unlimited", () => {
    const render = (limit: number | null) => renderToStaticMarkup(
      <ProjectAtomFields
        value={{
          instance: "atom",
          nodeId: "node-1",
          nodeTitle: "soulstream",
          depth: 3,
          titlesOnly: false,
          limit,
        }}
        disabled={false}
        onChange={vi.fn()}
      />,
    );

    expect(render(3)).toContain('aria-label="atom 최근 자식 수"');
    expect(render(3)).toContain('value="3"');
    expect(render(null)).toContain('placeholder="전체"');
    expect(render(null)).not.toContain('value="0"');
  });
});
