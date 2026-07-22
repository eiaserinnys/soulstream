/**
 * @vitest-environment jsdom
 */

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InitialTaskContextPicker, TaskContextPicker } from "./TaskContextPicker";

const pageApi = vi.hoisted(() => ({
  listPages: vi.fn(async () => ({ items: [] })),
  searchPages: vi.fn(async () => ({ items: [] })),
}));

vi.mock("@seosoyoung/soul-ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@seosoyoung/soul-ui")>();
  return {
    ...actual,
    AtomNodeSelector: ({ onChange }: { onChange(nodeId: string, title: string): void }) => (
      <button type="button" aria-label="테스트 atom 선택" onClick={() => onChange("node-soulstream", "soulstream")}>atom 선택</button>
    ),
  };
});

vi.mock("@seosoyoung/soul-ui/page", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@seosoyoung/soul-ui/page")>();
  return {
    ...actual,
    createPageApiClient: () => pageApi,
  };
});

describe("InitialTaskContextPicker atom options", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    document.body.replaceChildren();
  });

  it("edits depth and titles-only on the selected card before task creation", () => {
    const onChange = vi.fn();
    flushSync(() => root.render(
      <InitialTaskContextPicker
        value={{
          guidance: "",
          atomReferences: [{
            instance: "atom",
            nodeId: "node-soulstream",
            nodeTitle: "soulstream",
            depth: 3,
            titlesOnly: false,
          }],
        }}
        disabled={false}
        onChange={onChange}
      />,
    ));

    clickButton("＋ 컨텍스트");
    clickButton("🧠 atom");
    setSelect(select("soulstream atom depth"), "5");

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      atomReferences: [expect.objectContaining({ depth: 5, titlesOnly: false })],
    }));

    const checkbox = input("soulstream 제목만 포함");
    flushSync(() => checkbox.click());
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      atomReferences: [expect.objectContaining({ depth: 3, titlesOnly: true })],
    }));
  });

  it("keeps the same options on the existing-task selection card before apply", async () => {
    flushSync(() => root.render(
      <TaskContextPicker
        taskPageId="task-page"
        taskBlocks={[]}
        onBlocksChanged={vi.fn()}
        onClose={vi.fn()}
      />,
    ));
    await vi.waitFor(() => expect(pageApi.listPages).toHaveBeenCalled());

    clickButton("🧠 atom");
    clickButton("atom 선택");
    const depth = select("soulstream atom depth");
    setSelect(depth, "5");
    expect(depth.value).toBe("5");

    const titlesOnly = input("soulstream 제목만 포함");
    flushSync(() => titlesOnly.click());
    expect(titlesOnly.checked).toBe(true);
  });
});

function clickButton(label: string) {
  const target = [...document.body.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.trim() === label);
  if (!target) throw new Error(`${label} 버튼을 찾지 못했습니다.`);
  flushSync(() => target.click());
}

function select(label: string): HTMLSelectElement {
  const target = document.body.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
  if (!target) throw new Error(`${label} 선택을 찾지 못했습니다.`);
  return target;
}

function input(label: string): HTMLInputElement {
  const target = document.body.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (!target) throw new Error(`${label} 입력을 찾지 못했습니다.`);
  return target;
}

function setSelect(target: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
  flushSync(() => {
    setter?.call(target, value);
    target.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
