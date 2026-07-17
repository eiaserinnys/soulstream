/**
 * @vitest-environment jsdom
 */

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProjectDialog } from "./ProjectDialog";
import { fetchProjectPageDetails } from "./project-page-details";

vi.mock("./project-page-details", async (importOriginal) => {
  const original = await importOriginal<typeof import("./project-page-details")>();
  return {
    ...original,
    fetchProjectPageDetails: vi.fn(),
  };
});

const existingDetails = {
  page: {
    id: "existing",
    title: "기존 프로젝트",
    daily_date: null,
    version: 1,
    archived: false,
    metadata: {},
    created_at: "2026-07-17T00:00:00.000Z",
    updated_at: "2026-07-17T00:00:00.000Z",
  },
  blocks: [],
  stateVector: "",
  guidance: [],
  atomReferences: [],
  sessionDefaults: [],
};

describe("ProjectDialog shared form", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.mocked(fetchProjectPageDetails).mockResolvedValue(existingDetails);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    document.body.replaceChildren();
  });

  it("renders the same project form component for creation and settings", async () => {
    render({ mode: "create", parentFolderId: null, parentName: null });
    expect(document.body.querySelectorAll('[data-testid="v3-project-dialog-form"]')).toHaveLength(1);
    expect(sectionLabels()).toEqual(["guidance", "atom", "기본 에이전트"]);

    render({
      mode: "edit",
      folder: { id: "existing", name: "기존 프로젝트", sortOrder: 0, projectPageId: "existing" },
    });
    await vi.waitFor(() => expect(document.body.textContent).not.toContain("불러오는 중"));
    expect(document.body.querySelectorAll('[data-testid="v3-project-dialog-form"]')).toHaveLength(1);
    expect(sectionLabels()).toEqual(["guidance", "atom", "기본 에이전트"]);
  });

  it("does not expose stale settings when project context loading fails", async () => {
    vi.mocked(fetchProjectPageDetails).mockRejectedValueOnce(new Error("load failed"));
    render({
      mode: "edit",
      folder: { id: "existing", name: "기존 프로젝트", sortOrder: 0, projectPageId: "existing" },
    });
    await vi.waitFor(() => expect(document.body.textContent).toContain("프로젝트 설정을 불러오지 못했습니다"));
    expect(document.body.querySelector('[data-testid="v3-project-dialog-form"]')).toBeNull();
    expect(button("저장").disabled).toBe(true);
  });

  function render(target: Parameters<typeof ProjectDialog>[0]["target"]) {
    flushSync(() => root.render(
      <ProjectDialog
        target={target}
        onClose={vi.fn()}
        onCreateIdentity={vi.fn()}
        onRename={vi.fn()}
        onSaveContext={vi.fn()}
        onSaved={vi.fn()}
      />,
    ));
  }

  function sectionLabels(): string[] {
    return [...document.body.querySelectorAll("fieldset > legend")]
      .map((legend) => legend.textContent?.trim() ?? "");
  }

  function button(label: string): HTMLButtonElement {
    const target = [...document.body.querySelectorAll<HTMLButtonElement>("button")]
      .find((candidate) => candidate.textContent?.trim() === label);
    if (!target) throw new Error(`${label} 버튼을 찾지 못했습니다.`);
    return target;
  }
});
