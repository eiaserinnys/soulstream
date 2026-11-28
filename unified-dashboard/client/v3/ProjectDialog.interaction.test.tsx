/**
 * @vitest-environment jsdom
 */

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogFolder } from "@seosoyoung/soul-ui";

import { dialoguesAssignment } from "./dialogues-api";
import { ProjectDialog } from "./ProjectDialog";
import { fetchProjectPageDetails, type ProjectPageSnapshot } from "./project-page-details";

vi.mock("./project-page-details", async (importOriginal) => {
  const original = await importOriginal<typeof import("./project-page-details")>();
  return { ...original, fetchProjectPageDetails: vi.fn() };
});

const page = (id: string) => ({
  id, title: id, daily_date: null, version: 1, archived: false, metadata: {},
  created_at: "2026-07-17T00:00:00.000Z", updated_at: "2026-07-17T00:00:00.000Z",
});
const snapshot = (id: string, details: Partial<ProjectPageSnapshot> = {}): ProjectPageSnapshot => ({
  page: page(id), blocks: [], stateVector: "", guidance: [], atomReferences: [], sessionDefaults: [], ...details,
});

const parent: CatalogFolder = { status: "open", version: 1, archived: false, id: "parent", name: "소울스트림", sortOrder: 0, projectPageId: "parent-page" };
const child: CatalogFolder = { status: "open", version: 1, archived: false, id: "child", name: "대시보드", sortOrder: 0, parentFolderId: "parent", projectPageId: "child-page" };
const folders = [parent, child];

describe("ProjectDialog folder settings form", () => {
  let container: HTMLDivElement;
  let root: Root;
  let pages: Record<string, ProjectPageSnapshot>;

  beforeEach(() => {
    pages = {
      "parent-page": snapshot("parent-page", {
        guidance: [{ blockId: "pg", text: "부모 지침", scope: "project" }],
        atomReferences: [{ blockId: "pa", instance: "atom", nodeId: "soulstream", nodeTitle: "soulstream", depth: 5, titlesOnly: false }],
        sessionDefaults: [{ blockId: "pd", scope: "session", agentId: "roselin", nodeId: "sample-node", modelPreset: "sample-sol" }],
      }),
      "child-page": snapshot("child-page"),
    };
    vi.mocked(fetchProjectPageDetails).mockImplementation(async (pageId: string) => pages[pageId]!);
    vi.stubGlobal("PointerEvent", MouseEvent);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    flushSync(() => root.unmount());
    document.body.replaceChildren();
  });

  it("uses one form for new folders and settings, in the order name, description, instructions, references, environment", async () => {
    render({ mode: "create", parentFolderId: "parent", parentName: "소울스트림" });
    expect(document.body.querySelectorAll('[data-testid="v3-project-dialog-form"]')).toHaveLength(1);
    expect(fieldOrder()).toEqual(["상위 폴더", "이름", "설명", "지침", "참고 자료", "기본 실행 환경"]);
    expect(title()).toBe("새 폴더");

    render({ mode: "edit", folder: child });
    await vi.waitFor(() => expect(document.body.textContent).not.toContain("불러오는 중"));
    expect(document.body.querySelectorAll('[data-testid="v3-project-dialog-form"]')).toHaveLength(1);
    expect(fieldOrder()).toEqual(["상위 폴더", "이름", "설명", "지침", "참고 자료", "기본 실행 환경"]);
    expect(title()).toBe("폴더 설정");
  });

  it("joins several instruction blocks into one text box and saves it as the folder's own text", async () => {
    pages["child-page"] = snapshot("child-page", { guidance: [
      { blockId: "g1", text: "첫 지침", scope: "folder" },
      { blockId: "g2", text: "둘째 지침", scope: "project" },
    ] });
    const onSaveContext = vi.fn().mockResolvedValue(undefined);
    render({ mode: "edit", folder: child }, { onSaveContext });
    await vi.waitFor(() => expect(textarea("지침")).toBeTruthy());
    expect(document.body.querySelectorAll('textarea[aria-label="지침"]')).toHaveLength(1);
    expect(textarea("지침").value).toBe("첫 지침\n\n둘째 지침");
    flushSync(() => button("저장").click());
    await vi.waitFor(() => expect(onSaveContext).toHaveBeenCalled());
    expect(onSaveContext.mock.calls[0][2].guidance).toEqual({ source: "own", text: "첫 지침\n\n둘째 지침" });
  });

  it("shows inherited values with the nearest parent folder name and saves inheritance", async () => {
    const onSaveContext = vi.fn().mockResolvedValue(undefined);
    render({ mode: "edit", folder: child }, { onSaveContext });
    await vi.waitFor(() => expect(section("guidance").textContent).toContain("부모 지침"));
    expect(section("guidance").textContent).toContain("소울스트림");
    expect(pressed(section("guidance"))).toBe("물려받기");
    expect(section("references").textContent).toContain("soulstream");
    expect(section("references").querySelector('button[aria-label="soulstream 빼기"]')).toBeNull();
    await vi.waitFor(() => expect(section("defaults").textContent).toContain("로젤린 · sample-node · Sol"));
    flushSync(() => button("저장").click());
    await vi.waitFor(() => expect(onSaveContext).toHaveBeenCalled());
    expect(onSaveContext.mock.calls[0][2].guidance.source).toBe("inherit");
    expect(onSaveContext.mock.calls[0][2].sessionDefaults.source).toBe("inherit");
  });

  it("orders the environment fields node, agent, model and fills them from the inherited value", async () => {
    render({ mode: "edit", folder: child });
    await vi.waitFor(() => expect(section("defaults").textContent).toContain("로젤린"));
    flushSync(() => sectionButton("defaults", "직접 정하기").click());
    const labels = [...section("defaults").querySelectorAll("label")].map((label) => label.firstChild?.textContent?.trim());
    expect(labels).toEqual(["노드", "에이전트", "모델"]);
    expect(section("defaults").textContent).toContain("sample-node");
    expect(section("defaults").textContent).toContain("로젤린");
    expect(section("defaults").textContent).toContain("Sol");
  });

  it("does not expose stale settings when loading fails", async () => {
    vi.mocked(fetchProjectPageDetails).mockRejectedValue(new Error("load failed"));
    render({ mode: "edit", folder: child });
    await vi.waitFor(() => expect(document.body.textContent).toContain("폴더 설정을 불러오지 못했습니다"));
    expect(document.body.querySelector('[data-testid="v3-project-dialog-form"]')).toBeNull();
    expect(button("저장").disabled).toBe(true);
  });

  it("adds a reference with the node picker, depth buttons and titles-only switch, and returns focus on cancel", async () => {
    const request = vi.fn(async () => ({ ok: true, json: async () => ({ children: [{ id: "n", card: { title: "선택 자료" } }] }) })) as unknown as typeof fetch;
    render({ mode: "create", parentFolderId: null, parentName: null }, { request });
    await vi.waitFor(() => expect(sectionButton("references", "추가")).toBeTruthy());
    const add = sectionButton("references", "추가");
    flushSync(() => add.click());
    expect(title()).toBe("참고 자료 추가");
    expect(document.body.querySelector("select, input[type=number], input[type=checkbox]:not([aria-hidden=true])")).toBeNull();
    flushSync(() => footerButton("취소").click());
    await vi.waitFor(() => expect(document.activeElement).toBe(add));
    expect(title()).toBe("새 폴더");

    for (let i = 0; i < 2; i++) {
      flushSync(() => add.click());
      await vi.waitFor(() => expect(button("선택 자료")).toBeTruthy());
      flushSync(() => button("선택 자료").click());
      flushSync(() => button("2").click());
      flushSync(() => document.body.querySelector<HTMLElement>('[role="switch"]')!.click());
      flushSync(() => footerButton("추가").click());
    }
    const rows = [...section("references").querySelectorAll('button[aria-label="선택 자료 고치기"]')];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain("깊이 2 · 제목만");
  });

  it("blocks saving while a saved model is unavailable", async () => {
    pages["child-page"] = snapshot("child-page", { sessionDefaults: [{ blockId: "d", scope: "session", agentId: "roselin", nodeId: "sample-node", modelPreset: "missing" }] });
    render({ mode: "edit", folder: child });
    await vi.waitFor(() => expect(pressed(section("defaults"))).toBe("직접 정하기"));
    await vi.waitFor(() => expect(button("저장").disabled).toBe(true));
  });

  function render(target: Parameters<typeof ProjectDialog>[0]["target"], overrides: Partial<Parameters<typeof ProjectDialog>[0]> = {}) {
    flushSync(() => root.render(
      <ProjectDialog
        target={target}
        folders={folders}
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

  function title(): string {
    return document.body.querySelector('[data-slot="dialog-title"], h2')?.textContent?.trim() ?? "";
  }

  function fieldOrder(): string[] {
    const form = document.body.querySelector('[data-testid="v3-project-dialog-form"]')!;
    return [...form.children].map((element) => element.querySelector("span, strong")?.textContent?.trim() ?? "");
  }

  function section(name: string): HTMLElement {
    return document.body.querySelector<HTMLElement>(`[data-section="${name}"]`)!;
  }

  function pressed(scope: HTMLElement): string {
    return scope.querySelector('[aria-pressed="true"]')?.textContent?.trim() ?? "";
  }

  function sectionButton(name: string, label: string): HTMLButtonElement {
    const target = [...section(name).querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent?.trim() === label);
    if (!target) throw new Error(`${name}의 ${label} 버튼을 찾지 못했습니다.`);
    return target;
  }

  function textarea(label: string): HTMLTextAreaElement {
    return document.body.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${label}"]`)!;
  }

  function footerButton(label: string): HTMLButtonElement {
    const target = [...document.body.querySelectorAll<HTMLButtonElement>(".v3-succession-footer button")]
      .find((candidate) => candidate.textContent?.trim() === label);
    if (!target) throw new Error(`아래 ${label} 버튼을 찾지 못했습니다.`);
    return target;
  }

  function button(label: string): HTMLButtonElement {
    const target = [...document.body.querySelectorAll<HTMLButtonElement>("button")]
      .find((candidate) => candidate.textContent?.trim() === label);
    if (!target) throw new Error(`${label} 버튼을 찾지 못했습니다.`);
    return target;
  }
});
