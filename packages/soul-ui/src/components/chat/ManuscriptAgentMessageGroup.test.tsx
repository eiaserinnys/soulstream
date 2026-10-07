/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatMessage } from "../../lib/flatten-tree";
import { ManuscriptAgentMessageGroup } from "./ManuscriptAgentMessageGroup";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

function agentMessage(id: string, role: "user" | "intervention"): ChatMessage {
  return {
    id,
    role,
    content: `보고 ${id}`,
    treeNodeId: id,
    treeNodeType: role === "user" ? "user_message" : "intervention",
    callerInfo: { source: "agent", agent_node: "eiaserinnys" },
    agentInfo: { source: "agent", agent_node: "eiaserinnys", agent_id: "roselin", agent_name: "로젤린" },
  };
}

describe("ManuscriptAgentMessageGroup", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    if (root !== null) act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
  });

  it("starts collapsed, expands existing manuscript messages in order, and can collapse again", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const messages = [
      agentMessage("one", "user"),
      agentMessage("two", "intervention"),
      agentMessage("three", "user"),
    ];

    act(() => root?.render(<ManuscriptAgentMessageGroup messages={messages} />));

    const button = container.querySelector("button")!;
    expect(button.textContent).toBe("다른 세션 메시지 3건");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    const bodyId = button.getAttribute("aria-controls")!;
    expect(document.getElementById(bodyId)?.hasAttribute("hidden")).toBe(true);

    act(() => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById(bodyId)?.hasAttribute("hidden")).toBe(false);
    expect(Array.from(container.querySelectorAll('[data-slot="chat-body"]')).map(node => node.textContent))
      .toEqual(["보고 one", "보고 two", "보고 three"]);
    expect(container.querySelectorAll('[data-chat-manuscript-user-row]')).toHaveLength(3);

    act(() => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(document.getElementById(bodyId)?.hasAttribute("hidden")).toBe(true);
  });

  it("keeps its open row and identity when a late agent message joins the group", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const firstTwo = [agentMessage("one", "user"), agentMessage("two", "intervention")];

    act(() => root?.render(<ManuscriptAgentMessageGroup messages={firstTwo} />));
    const row = container.querySelector('[data-slot="manuscript-agent-message-group"]');
    const button = container.querySelector("button")!;
    act(() => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    act(() => root?.render(<ManuscriptAgentMessageGroup messages={[...firstTwo, agentMessage("three", "user")]} />));

    expect(container.querySelector('[data-slot="manuscript-agent-message-group"]')).toBe(row);
    expect(container.querySelector("button")?.textContent).toBe("다른 세션 메시지 3건");
    expect(container.querySelector("button")?.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelectorAll('[data-chat-manuscript-user-row]')).toHaveLength(3);
  });
});
