import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("v3 task section navigation contract", () => {
  it("keeps the director-approved task detail section order", () => {
    const detail = read("./TaskDetailPane.tsx");
    const order = ["information", "checklist", "board", "sessions"]
      .map((id) => detail.indexOf(`data-task-section=\"${id}\"`));

    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((left, right) => left - right));
    expect(detail).not.toContain('data-task-section="description"');
    expect(detail).not.toContain('data-task-section="context"');
  });

  it("uses a quiet four-item anchor rail with a rounded focus ring and a narrow-width cutoff", () => {
    const detail = read("./TaskDetailPane.tsx");
    const navigation = read("./TaskSectionNavigation.tsx");
    const css = read("./v3-task-section-navigation.css");

    expect(detail).toContain("<TaskSectionNavigation");
    expect(navigation).toContain('aria-current={activeSection === id ? "location" : undefined}');
    expect(navigation).not.toContain("glass-strong glass-chrome lg-rim");
    expect(navigation).not.toContain("v3-task-section-nav-title");
    expect(navigation).not.toMatch(/collaps|접기|펼치기/i);
    expect(css).toMatch(/\.v3-task-section-nav\s*\{[^}]*position:\s*sticky/s);
    expect(css).toMatch(/\.v3-task-detail-layout\s*\{[^}]*grid-template-columns:\s*58px\s+minmax\(0,\s*1fr\)/s);
    expect(css).toMatch(/\.v3-task-section-anchor\s*\{[^}]*min-height:\s*38px/s);
    expect(css).toMatch(/\.v3-task-section-anchor:focus-visible\s*\{[^}]*box-shadow:/s);
    expect(css).not.toMatch(/\.v3-task-section-anchor:focus-visible\s*\{[^}]*outline:\s*2px/s);
    expect(css).toMatch(/@container\s*\(max-width:\s*620px\)[\s\S]*\.v3-task-section-nav\s*\{[^}]*display:\s*none/s);
  });
});
