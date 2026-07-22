/**
 * @vitest-environment jsdom
 */

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NewTaskForm } from "./NewTaskForm";

vi.mock("./use-project-context-inheritance", () => ({
  useProjectContextInheritance: () => ({
    status: "loading",
    folderId: "folder-a",
    data: null,
    message: null,
  }),
}));

vi.mock("./AgentNodeAssignmentFields", () => ({
  AgentNodeAssignmentFields: ({ agentId, nodeId, onAgentIdChange, onNodeIdChange }: {
    agentId: string;
    nodeId: string;
    onAgentIdChange(value: string): void;
    onNodeIdChange(value: string): void;
  }) => (
    <>
      <input aria-label="노드 선택" value={nodeId} onChange={(event) => onNodeIdChange(event.target.value)} />
      <input aria-label="에이전트 선택" value={agentId} onChange={(event) => onAgentIdChange(event.target.value)} />
    </>
  ),
}));

describe("NewTaskForm submission feedback", () => {
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

  it("keeps the dialog open and shows the canonical 401 message inside it", async () => {
    const request = deferred<string | null>();
    const onCreate = vi.fn(() => request.promise);
    render(onCreate);

    setInputValue(input("새 업무 제목"), "인증 회귀 확인");
    button("업무 만들기").click();
    await vi.waitFor(() => expect(button("만드는 중…").disabled).toBe(true));

    button("만드는 중…").click();
    expect(onCreate).toHaveBeenCalledTimes(1);

    request.resolve("로그인이 만료되었습니다. 다시 로그인해 주세요");
    await vi.waitFor(() => {
      expect(document.body.querySelector('[role="alert"]')?.textContent)
        .toContain("로그인이 만료되었습니다. 다시 로그인해 주세요");
    });
    expect(document.body.textContent).toContain("새 업무");
    expect(button("업무 만들기").disabled).toBe(false);
  });

  it("submits a complete direct session default with the initial task context", async () => {
    const onCreate = vi.fn(async () => null);
    render(onCreate);

    setInputValue(input("새 업무 제목"), "기본 담당 업무");
    setInputValue(input("노드 선택"), "eiaserinnys");
    expect(button("업무 만들기").disabled).toBe(true);
    setInputValue(input("에이전트 선택"), "roselin_codex");
    button("업무 만들기").click();

    await vi.waitFor(() => expect(onCreate).toHaveBeenCalledWith(
      "기본 담당 업무",
      "folder-a",
      "",
      {
        guidance: "",
        atomReferences: [],
        sessionDefaults: {
          agentId: "roselin_codex",
          nodeId: "eiaserinnys",
        },
      },
    ));
  });

  function render(onCreate: (...args: never[]) => Promise<string | null>) {
    flushSync(() => root.render(
      <NewTaskForm
        folders={[folder()]}
        initialFolderId="folder-a"
        pending={false}
        onCreate={onCreate}
        onCancel={vi.fn()}
      />,
    ));
  }
});

function input(label: string): HTMLInputElement {
  const target = document.body.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (!target) throw new Error(`${label} 입력을 찾지 못했습니다.`);
  return target;
}

function button(label: string): HTMLButtonElement {
  const target = [...document.body.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.trim() === label);
  if (!target) throw new Error(`${label} 버튼을 찾지 못했습니다.`);
  return target;
}

function setInputValue(target: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(target, value);
  target.dispatchEvent(new Event("input", { bubbles: true }));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function folder() {
  return {
    id: "folder-a",
    name: "프로젝트 A",
    parentFolderId: null,
    sortOrder: 0,
    projectPageId: "project-a",
  };
}
