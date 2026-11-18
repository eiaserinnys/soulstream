/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ProjectContextEditor } from "./ProjectContextEditor";
import type { ProjectPageSnapshot } from "./project-page-details";

describe("ProjectContextEditor", () => {
  it("keeps guidance visible and exposes atom/default editors as popover triggers", () => {
    const snapshot = {
      page: { id: "project-1", title: "프로젝트", version: 1 },
      blocks: [],
      stateVector: "AA==",
      guidance: [{ blockId: "guidance-1", text: "프로젝트 지침 본문" }],
      atomReferences: [{
        blockId: "atom-1",
        instance: "atom",
        nodeId: "node-1",
        nodeTitle: "소울스트림",
        depth: 3,
        titlesOnly: false,
      }],
      sessionDefaults: [{ blockId: "defaults-1", agentId: "roselin_codex", nodeId: "eiaserinnys" }],
    } as unknown as ProjectPageSnapshot;

    const html = renderToStaticMarkup(
      <ProjectContextEditor pageId="project-1" snapshot={snapshot} onChanged={vi.fn(async () => undefined)} />,
    );

    expect(html).toContain('data-testid="v3-project-guidance-guidance-1"');
    expect(html).toContain("프로젝트 지침 본문");
    expect(html.match(/aria-haspopup="dialog"/g)).toHaveLength(3);
    expect(html).not.toContain('data-editor-presentation="inline-expansion"');
  });
});

it("prevents saving while the inline node selector is open", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const request = vi.fn(async () => Response.json({ children: [] })) as unknown as typeof fetch;
  const snapshot = {
    page: { id: "project-1", title: "프로젝트", version: 1 }, blocks: [], stateVector: "AA==", guidance: [],
    atomReferences: [{ blockId: "atom-1", instance: "atom", nodeId: "node-1", nodeTitle: "지식", depth: 3, titlesOnly: false }],
    sessionDefaults: [],
  } as unknown as ProjectPageSnapshot;
  try {
    await act(async () => { root.render(<ProjectContextEditor pageId="project-1" snapshot={snapshot} request={request} initialEditor="atom-edit" onChanged={vi.fn(async () => undefined)} />); });
    const popup = document.querySelector(".v3-project-context-popover")!;
    const save = [...popup.querySelectorAll("button")].find(button => button.textContent === "저장")!;
    expect(popup.querySelector('[data-slot="atom-node-selector-panel"]')).not.toBeNull();
    expect(save.disabled).toBe(true);
    const trigger = popup.querySelector<HTMLButtonElement>('button[aria-expanded="true"]')!;
    await act(async () => { trigger.click(); });
    expect(popup.querySelector('[data-slot="atom-node-selector-panel"]')).toBeNull();
    expect(save.disabled).toBe(false);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
