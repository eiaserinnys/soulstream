/**
 * @vitest-environment jsdom
 */

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dialoguesAssignment } from "./dialogues-api";
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
    expect(sectionLabels()).toEqual(["작업 지침", "참고 자료", "기본 에이전트"]);

    render({
      mode: "edit",
      folder: { status: "open" as const, version: 1, archived: false, id: "existing", name: "기존 프로젝트", sortOrder: 0, projectPageId: "existing" },
    });
    await vi.waitFor(() => expect(document.body.textContent).not.toContain("불러오는 중"));
    expect(document.body.querySelectorAll('[data-testid="v3-project-dialog-form"]')).toHaveLength(1);
    expect(sectionLabels()).toEqual(["작업 지침", "참고 자료", "기본 에이전트"]);
  });

  it("does not expose stale settings when project context loading fails", async () => {
    vi.mocked(fetchProjectPageDetails).mockRejectedValueOnce(new Error("load failed"));
    render({
      mode: "edit",
      folder: { status: "open" as const, version: 1, archived: false, id: "existing", name: "기존 프로젝트", sortOrder: 0, projectPageId: "existing" },
    });
    await vi.waitFor(() => expect(document.body.textContent).toContain("프로젝트 설정을 불러오지 못했습니다"));
    expect(document.body.querySelector('[data-testid="v3-project-dialog-form"]')).toBeNull();
    expect(button("저장").disabled).toBe(true);
  });

  it("reuses the empty guidance row and focuses it without writing", () => {
    render({ mode: "create", parentFolderId: null, parentName: null });
    flushSync(() => button("지침 추가").click());
    flushSync(() => button("지침 추가").click());
    expect(document.body.querySelectorAll("textarea")).toHaveLength(1);
    expect(document.activeElement).toBe(document.body.querySelector("textarea"));
  });

  it("keeps atom selection local on cancel, restores focus, and replaces duplicate confirmation", async () => {
    const request = vi.fn(async () => ({ ok: true, json: async () => ({ children: [{ id: "n", card: { title: "선택 자료" } }] }) })) as unknown as typeof fetch;
    render({ mode: "create", parentFolderId: null, parentName: null }, { request });
    const add = button("atom에서 추가");
    flushSync(() => add.click());
    await vi.waitFor(() => expect(button("선택 자료")).toBeTruthy());
    flushSync(() => button("선택 자료").click());
    flushSync(() => button("취소").click());
    await vi.waitFor(() => expect(document.activeElement).toBe(add));
    expect(document.body.querySelector('[data-testid="v3-project-dialog-form"]')?.textContent).not.toContain("선택 자료");
    for (let i = 0; i < 2; i++) {
      flushSync(() => add.click());
      await vi.waitFor(() => expect(button("선택 자료")).toBeTruthy());
      flushSync(() => button("선택 자료").click());
      flushSync(() => button("자료 추가").click());
    }
    expect([...document.body.querySelectorAll('button')].filter(b => b.textContent === "선택 자료 · atom")).toHaveLength(1);
  });

  it("cancels execution defaults without changing the parent and confirms all-unspecified as inheritance", async () => {
    const onSaveContext = vi.fn().mockResolvedValue(undefined);
    render({ mode: "create", parentFolderId: null, parentName: null }, { onSaveContext, onCreateIdentity: vi.fn().mockResolvedValue({ id: "new", name: "이름" }) });
    change(document.body.querySelector('input[aria-label="폴더 이름"]')!, "이름");
    flushSync(() => button("＋ 기본 에이전트").click());
    const node = document.body.querySelector('select[aria-label="기본 실행 노드"]')!;
    change(node, "sample-node");
    flushSync(() => button("취소").click());
    expect(document.body.textContent).not.toContain("기본 실행 환경 편집");
    flushSync(() => button("＋ 기본 에이전트").click());
    flushSync(() => button("확인").click());
    flushSync(() => button("만들기").click());
    await vi.waitFor(() => expect(onSaveContext).toHaveBeenCalled());
    expect(onSaveContext.mock.calls[0][2].sessionDefaults).toBeNull();
  });

  function change(element: Element, value: string) {
    const prototype = element.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    flushSync(() => {
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
      element.dispatchEvent(new Event(element.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
    });
  }

  function render(target: Parameters<typeof ProjectDialog>[0]["target"], overrides: Partial<Parameters<typeof ProjectDialog>[0]> = {}) {
    flushSync(() => root.render(
      <ProjectDialog
        target={target}
        assignment={dialoguesAssignment}
        onClose={vi.fn()}
        onCreateIdentity={vi.fn()}
        onRename={vi.fn()}
        onSaveContext={vi.fn()}
        onSaved={vi.fn()}
        {...overrides}
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
