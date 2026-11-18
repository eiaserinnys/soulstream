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
    expect(render(null)).toContain('aria-label="atom 렌더 방식"');
    expect(render(null)).toContain('<option value="" selected="">기존 방식</option>');
  });
});

it("opens the node selector inline inside the atom fields", () => {
  const html = renderToStaticMarkup(<ProjectAtomFields
    value={{ instance: "atom", nodeId: "", nodeTitle: "", depth: 3, titlesOnly: false }}
    disabled={false} selectorOpen onChange={vi.fn()} />);
  expect(html).toContain('data-slot="atom-node-selector-panel"');
  expect(html.indexOf('data-slot="atom-node-selector-panel"')).toBeLessThan(html.indexOf("깊이"));
});

it("keeps a closed inline selector out of the tab order", () => {
  const html = renderToStaticMarkup(<ProjectAtomFields
    value={{ instance: "atom", nodeId: "node-1", nodeTitle: "지식", depth: 3, titlesOnly: false }}
    disabled={false} selectorOpen={false} onChange={vi.fn()} />);
  expect(html).not.toContain('data-slot="atom-node-selector-panel"');
});
