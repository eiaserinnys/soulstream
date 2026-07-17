/**
 * @vitest-environment jsdom
 */

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TaskDefaultAssignment } from "./TaskDefaultAssignment";

vi.mock("./AgentNodeAssignmentFields", () => ({
  AgentNodeAssignmentFields: ({ agentId, nodeId, onAgentIdChange, onNodeIdChange }: {
    agentId: string;
    nodeId: string;
    onAgentIdChange(value: string): void;
    onNodeIdChange(value: string): void;
  }) => (
    <>
      <input aria-label="에이전트 선택" value={agentId} onChange={(event) => onAgentIdChange(event.target.value)} />
      <input aria-label="노드 선택" value={nodeId} onChange={(event) => onNodeIdChange(event.target.value)} />
    </>
  ),
}));

describe("TaskDefaultAssignment", () => {
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

  it("shows the inheritance source and saves the edited value as an explicit assignment", async () => {
    const onSave = vi.fn(async () => undefined);
    render(onSave);

    expect(button("기본 담당 수정").textContent).toContain("seosoyoung@eiaserinnys");
    expect(button("기본 담당 수정").textContent).toContain("소울스트림에서 상속");
    click("기본 담당 수정");
    setInput(input("에이전트 선택"), "roselin_codex");
    setInput(input("노드 선택"), "eias-linegames-wsl");
    click("직접 지정");

    await vi.waitFor(() => expect(onSave).toHaveBeenCalledWith({
      agentId: "roselin_codex",
      nodeId: "eias-linegames-wsl",
    }));
    await vi.waitFor(() => expect(document.body.querySelector('input[aria-label="에이전트 선택"]')).toBeNull());
  });

  it("keeps the editor and selected values visible when persistence fails", async () => {
    const onSave = vi.fn(async () => { throw new Error("저장 실패"); });
    render(onSave);
    click("기본 담당 수정");
    setInput(input("에이전트 선택"), "failed-agent");
    click("직접 지정");

    await vi.waitFor(() => expect(document.body.querySelector('[role="alert"]')?.textContent).toContain("저장 실패"));
    expect(input("에이전트 선택").value).toBe("failed-agent");
  });

  function render(onSave: (value: { agentId: string; nodeId: string }) => Promise<void>) {
    flushSync(() => root.render(
      <TaskDefaultAssignment
        agentId="seosoyoung"
        nodeId="eiaserinnys"
        sourceLabel="소울스트림에서 상속"
        onSave={onSave}
      />,
    ));
  }
});

function button(label: string): HTMLButtonElement {
  const target = [...document.body.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.getAttribute("aria-label") === label || candidate.textContent?.trim() === label);
  if (!target) throw new Error(`${label} 버튼을 찾지 못했습니다.`);
  return target;
}

function input(label: string): HTMLInputElement {
  const target = document.body.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (!target) throw new Error(`${label} 입력을 찾지 못했습니다.`);
  return target;
}

function click(label: string) {
  flushSync(() => button(label).click());
}

function setInput(target: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  flushSync(() => {
    setter?.call(target, value);
    target.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
