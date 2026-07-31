/**
 * @vitest-environment jsdom
 */

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TaskDefaultAssignment } from "./TaskDefaultAssignment";

vi.mock("./AgentNodeAssignmentFields", () => ({
  AgentNodeAssignmentFields: ({ agentId, nodeId, modelPreset, layout, onAgentIdChange, onNodeIdChange, onModelPresetChange }: {
    agentId: string;
    nodeId: string;
    modelPreset: string;
    layout?: string;
    onAgentIdChange(value: string): void;
    onNodeIdChange(value: string): void;
    onModelPresetChange(value: string): void;
  }) => (
    <div data-testid="assignment-fields" data-layout={layout}>
      <input aria-label="에이전트 선택" value={agentId} onChange={(event) => onAgentIdChange(event.target.value)} />
      <input aria-label="노드 선택" value={nodeId} onChange={(event) => onNodeIdChange(event.target.value)} />
      <input aria-label="모델 선택" value={modelPreset} onChange={(event) => onModelPresetChange(event.target.value)} />
    </div>
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

  it("shows the selected node, agent, and model with one accessible edit action", () => {
    render(vi.fn(async () => undefined));

    const summary = element("task-default-summary");
    expect(summary.textContent).toContain("eiaserinnys");
    expect(summary.textContent).toContain("seosoyoung");
    expect(summary.textContent).toContain("preset-inherited");
    expect(summary.textContent).not.toContain("모델 지정");
    expect(summary.textContent).not.toContain("직접 지정");
    expect(summary.textContent).not.toContain("상속");
    expect(summary.querySelectorAll("button")).toHaveLength(1);
    expect(button("기본 담당 편집").getAttribute("aria-expanded")).toBe("false");
  });

  it("saves the edited value through the compact assignment editor", async () => {
    const onSave = vi.fn(async () => undefined);
    render(onSave);

    click("기본 담당 편집");
    expect(element("assignment-fields").dataset.layout).toBe("compact-row");
    setInput(input("에이전트 선택"), "roselin_codex");
    setInput(input("노드 선택"), "eias-linegames-wsl");
    setInput(input("모델 선택"), "preset-a");
    click("저장");

    await vi.waitFor(() => expect(onSave).toHaveBeenCalledWith({
      agentId: "roselin_codex",
      nodeId: "eias-linegames-wsl",
      modelPreset: "preset-a",
    }));
    await vi.waitFor(() => expect(document.body.querySelector('input[aria-label="에이전트 선택"]')).toBeNull());
  });

  it("keeps the editor and selected values visible when persistence fails", async () => {
    const onSave = vi.fn(async () => { throw new Error("저장 실패"); });
    render(onSave);
    click("기본 담당 편집");
    setInput(input("에이전트 선택"), "failed-agent");
    click("저장");

    await vi.waitFor(() => expect(document.body.querySelector('[role="alert"]')?.textContent).toContain("저장 실패"));
    expect(input("에이전트 선택").value).toBe("failed-agent");
  });

  it("resets the model preset when its node changes", () => {
    render(vi.fn(async () => undefined));
    click("기본 담당 편집");
    expect(input("모델 선택").value).toBe("preset-inherited");

    setInput(input("노드 선택"), "other-node");

    expect(input("모델 선택").value).toBe("");
  });

  it("allows a task with no inherited defaults to set its first explicit assignment", async () => {
    const onSave = vi.fn(async () => undefined);
    render(onSave, {
      agentId: null,
      nodeId: null,
      modelPreset: null,
    });

    expect(element("task-default-summary").textContent).toContain("노드 미지정");
    expect(element("task-default-summary").textContent).toContain("에이전트 미지정");
    expect(element("task-default-summary").textContent).toContain("모델 미지정");
    click("기본 담당 편집");
    setInput(input("노드 선택"), "eiaserinnys");
    setInput(input("에이전트 선택"), "roselin_codex");
    setInput(input("모델 선택"), "preset-a");
    click("저장");

    await vi.waitFor(() => expect(onSave).toHaveBeenCalledWith({
      agentId: "roselin_codex",
      nodeId: "eiaserinnys",
      modelPreset: "preset-a",
    }));
  });

  it("restores persisted values when editing is cancelled", () => {
    const onSave = vi.fn(async () => undefined);
    render(onSave);
    click("기본 담당 편집");
    setInput(input("에이전트 선택"), "draft-agent");
    setInput(input("모델 선택"), "draft-model");

    click("취소");

    expect(onSave).not.toHaveBeenCalled();
    expect(document.body.querySelector('input[aria-label="에이전트 선택"]')).toBeNull();
    expect(element("task-default-summary").textContent).toContain("seosoyoung");
    expect(element("task-default-summary").textContent).toContain("preset-inherited");
  });

  function render(
    onSave: (value: { agentId: string; nodeId: string; modelPreset: string }) => Promise<void>,
    value: {
      agentId: string | null;
      nodeId: string | null;
      modelPreset: string | null;
    } = {
      agentId: "seosoyoung",
      nodeId: "eiaserinnys",
      modelPreset: "preset-inherited",
    },
  ) {
    flushSync(() => root.render(
      <TaskDefaultAssignment
        agentId={value.agentId}
        nodeId={value.nodeId}
        modelPreset={value.modelPreset}
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

function element(testId: string): HTMLElement {
  const target = document.body.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (!target) throw new Error(`${testId} 요소를 찾지 못했습니다.`);
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
