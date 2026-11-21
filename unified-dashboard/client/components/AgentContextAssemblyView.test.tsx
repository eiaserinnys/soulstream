/** @vitest-environment jsdom */
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { AgentContextAssemblyView } from "./AgentContextAssemblyView";
import { assemblyBundles, assemblyContexts, assemblyPreview } from "../v3/agent-profile-assembly-fixture";

it("assembles a node-only profile with its agent context and labels the origin", async () => {
  const request = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({
    manifest: { sources: [{ node_id: "source-id", status: "ok", chars: 4, token_estimate: 1 }] },
    sections: [{ spec_index: 0, title: "지침", markdown: "본문" }], assembled: "본문", atom_base_url: null,
  }));
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => root.render(createElement(AgentContextAssemblyView, {
    target: { kind: "node", agentId: "node-agent" }, nodeId: "node-a", initialBackend: "codex", presentOnNode: true, request,
  })));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(JSON.parse(request.mock.calls[0]![1]!.body as string)).toEqual({
    agent_id: "node-agent", session: { source: "browser", backend: "codex", agent: "node-agent" },
  });
  expect(container.textContent).toContain("노드 설정");
  flushSync(() => root.unmount());
  container.remove();
});

it("reassembles for conditions, shows source failures and copies the exact result", async () => {
  const specs = [...assemblyBundles.flatMap(bundle => bundle.atom_contexts), ...assemblyContexts];
  const request = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => Response.json(assemblyPreview(JSON.parse(String(init?.body)))));
  const writeText = vi.fn(async (_value: string) => {});
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => root.render(createElement(AgentContextAssemblyView, {
    target: { kind: "central", agentId: "agent", specs: specs.map(context => ({ context, source: "번들" })) },
    nodeId: "node-a", initialBackend: "claude", presentOnNode: true, request,
  })));
  await vi.waitFor(() => expect(container.textContent).toContain("실패"));
  expect(container.textContent).toContain("빠짐");
  const change = (label: string, value: string) => {
    const select = container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
    flushSync(() => { select.value = value; select.dispatchEvent(new Event("change", { bubbles: true })); });
  };
  change("조립 백엔드", "codex");
  change("조립 카드 역할", "assignee");
  await vi.waitFor(() => expect(JSON.parse(String(request.mock.calls.at(-1)?.[1]?.body)).session).toMatchObject({ backend: "codex", card_role: "assignee" }));
  await vi.waitFor(() => expect(container.textContent).toContain("조건부 지침"));
  const all = Array.from(container.querySelectorAll("button")).find(button => button.textContent?.startsWith("전체"))!;
  flushSync(() => all.click());
  flushSync(() => container.querySelector<HTMLButtonElement>('button[aria-label="전체 복사"]')!.click());
  await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(assemblyPreview({ atom_contexts: specs, session: { backend: "codex", card_role: "assignee" } }).assembled));
  flushSync(() => root.unmount()); container.remove(); vi.unstubAllGlobals();
});

it("omits token estimates in non-included source details", async () => {
  const base = assemblyBundles.flatMap(bundle => bundle.atom_contexts);
  const specs = [...base, { node_id: "30000000-0000-4000-8000-000000000001", depth: 1 }, base[0]!];
  const request = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => Response.json(assemblyPreview(JSON.parse(String(init?.body)))));
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => root.render(createElement(AgentContextAssemblyView, {
    target: { kind: "central", agentId: "agent", specs: specs.map(context => ({ context, source: "번들" })) },
    nodeId: "node-a", initialBackend: "claude", presentOnNode: true, request,
  })));
  await vi.waitFor(() => expect(container.textContent).toContain("실패 소스"));
  for (const status of ["filtered", "error", "empty", "duplicate"]) {
    const row = container.querySelector<HTMLButtonElement>(`button[data-status="${status}"]`)!;
    expect(row).not.toBeNull();
    expect(row.textContent).not.toContain("토큰");
    flushSync(() => row.click());
    expect(container.querySelector('[data-testid="agent-context-assembly-detail"]')?.textContent).not.toContain("토큰");
    flushSync(() => container.querySelector<HTMLButtonElement>('button[aria-label="소스 목록으로"]')!.click());
  }
  flushSync(() => root.unmount()); container.remove();
});
