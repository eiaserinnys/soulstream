import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("PR-CL v3 visual system contract", () => {
  it("loads the visual system after the legacy component styles", () => {
    const entry = read("./v3-dashboard-styles.ts");

    expect(entry.trim().endsWith('import "./v3-visual-system.css";')).toBe(true);
  });

  it("defines the seven typography roles with exact metrics", () => {
    const css = read("./v3-visual-system.css");

    expect(css).toContain('--v3-type-page: 680 21px/28px');
    expect(css).toContain('--v3-type-section: 650 16px/24px');
    expect(css).toContain('--v3-type-card: 600 16px/23px');
    expect(css).toContain('--v3-type-side-title: 600 14px/20px');
    expect(css).toContain('--v3-type-body: 450 14px/22px');
    expect(css).toContain('--v3-type-meta: 500 12px/18px');
    expect(css).toContain('--v3-type-badge: 600 11px/16px');
    expect(css).toContain('font-family: "Pretendard Variable", Pretendard');
  });

  it("fixes the card grids, section rhythm, and semantic progress roles", () => {
    const css = read("./v3-visual-system.css");

    expect(css).toMatch(/\.v3-task-list[^{]*\{[^}]*gap:\s*var\(--v3-space-1\)/s);
    expect(css).toMatch(/\.v3-session-list[^{]*\{[^}]*gap:\s*var\(--v3-space-1\)/s);
    expect(css).toContain('grid-template-columns: minmax(0, 1fr) var(--v3-task-state-column) var(--v3-action-size)');
    expect(css).toContain('grid-template-columns: var(--v3-session-avatar-size) minmax(0, 1fr) var(--v3-session-meta-column)');
    expect(css).toContain('grid-template-columns: var(--v3-tree-toggle-column) var(--v3-tree-drag-column) var(--v3-tree-icon-column) minmax(0, 1fr)');
    expect(css).toContain('padding-left: calc(var(--v3-project-depth, 0) * var(--v3-tree-indent-step))');
    expect(css).toMatch(/\.v3-progress > i[^{]*\{[^}]*background:\s*var\(--v3-accent\)/s);
    expect(css).toMatch(/--v3-complete:\s*var\(--info\)/);
    expect(css).toMatch(/\.v3-progress\[data-complete="true"\] > i[^{]*\{[^}]*background:\s*var\(--v3-progress-complete\)/s);
  });

  it("defines three glass densities, the darker detail surface, and responsive exits", () => {
    const css = read("./v3-visual-system.css");

    expect(css).toContain('--v3-glass-panel: color-mix(in srgb, var(--background) 16%, transparent)');
    expect(css).toContain('--v3-glass-card: color-mix(in srgb, var(--background) 34%, transparent)');
    expect(css).toContain('--v3-glass-dense: color-mix(in srgb, var(--background) 48%, transparent)');
    expect(css).toContain('--v3-glass-detail: color-mix(in srgb, var(--background) 24%, transparent)');
    expect(css).toContain('@media (max-width: 1180px)');
    expect(css).toContain('@media (max-width: 760px)');
  });

  it("keeps chat rows readable with explicit slots instead of utility coupling", () => {
    const user = read("../../../packages/soul-ui/src/components/chat/UserMessage.tsx");
    const assistant = read("../../../packages/soul-ui/src/components/chat/AssistantMessage.tsx");
    const css = read("./v3-visual-system.css");

    expect(user).toContain('data-slot="chat-message-row"');
    expect(user).toContain('data-slot="chat-message-bubble"');
    expect(assistant).toContain('data-slot="chat-message-row"');
    expect(assistant).toContain('data-slot="chat-message-bubble"');
    expect(css).toMatch(/\[data-slot="chat-message-row"\][^{]*\{[^}]*padding-block:\s*6px/s);
    expect(css).toMatch(/\[data-slot="chat-message-bubble"\][^{]*\{[^}]*max-width:\s*88%[^}]*padding:\s*14px 16px/s);
  });
});
