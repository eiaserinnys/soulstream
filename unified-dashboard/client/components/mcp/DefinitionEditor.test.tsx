/** @vitest-environment jsdom */
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { DefinitionEditor, McpValueUnit } from "./DefinitionEditor";
import { newUnit, readDefinition } from "./definition";

it("앞 줄을 빼도 뒤 줄의 값 교체는 뒤 줄 비밀에 적용된다", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const updates = vi.fn();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  function Sample() {
    const [draft, setDraft] = useState(() =>
      readDefinition({
        type: "streamable_http",
        config: {
          url: "https://example.invalid",
          headers: { First: "{{secret:first}}", Second: "{{secret:second}}" },
        },
      }),
    );
    return (
      <DefinitionEditor
        value={draft}
        secretNames={["first", "second"]}
        onChange={setDraft}
        onSecretValue={updates}
      />
    );
  }
  try {
    await act(async () => root.render(<Sample />));
    const buttons = (text: string) =>
      [...host.querySelectorAll("button")].filter(
        (button) => button.textContent === text,
      );
    await act(async () => buttons("값 교체")[1].click());
    await act(async () => buttons("줄 빼기")[0].click());
    const input = host.querySelector(
      "input[type=password]",
    ) as HTMLInputElement;
    expect(input).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, "obviously-fake-value");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(updates).toHaveBeenLastCalledWith(
      expect.any(String),
      "second",
      "obviously-fake-value",
    );
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});

it("노드 덮어쓰기 값은 공유 비밀을 교체하지 않고 그 정의에 넣는다", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const changes = vi.fn();
  const shared = vi.fn();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <McpValueUnit
          unit={newUnit({
            kind: "header",
            name: "Authorization",
            value: "Bearer {{secret:shared}}",
          })}
          isolateValue
          secretNames={["shared"]}
          onChange={changes}
          onRemove={() => undefined}
          onSecretValue={shared}
        />,
      ),
    );
    await act(async () =>
      [...host.querySelectorAll("button")]
        .find((button) => button.textContent === "값 교체")!
        .click(),
    );
    const input = host.querySelector(
      "input[type=password]",
    ) as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, "obviously-fake-value");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(changes).toHaveBeenLastCalledWith(
      expect.objectContaining({ value: "Bearer obviously-fake-value" }),
    );
    expect(shared).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});

it("stdio 명령을 새로 입력하면 숨은 full_command를 제거한다", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const changes = vi.fn();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    const draft = readDefinition({
      type: "stdio",
      config: { full_command: "fake-original-command" },
    });
    await act(async () =>
      root.render(
        <DefinitionEditor
          value={draft}
          secretNames={[]}
          onChange={changes}
          onSecretValue={() => undefined}
        />,
      ),
    );
    const input = [...host.querySelectorAll("input")].find((element) =>
      element.closest("label")?.textContent?.includes("command"),
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, "fake-new-command");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(changes).toHaveBeenCalledWith(
      expect.objectContaining({ config: { command: "fake-new-command" } }),
    );
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});

it.each([
  ["streamable_http", "stdio", "env"],
  ["stdio", "streamable_http", "header"],
] as const)("%s에서 %s로 바꾼 뒤 줄을 더하면 %s다", async (initial, next, kind) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const changes = vi.fn();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const editor = (type: "streamable_http" | "stdio") => (
    <DefinitionEditor
      value={readDefinition({ type, config: {} })}
      secretNames={[]}
      onChange={changes}
      onSecretValue={() => undefined}
    />
  );
  try {
    await act(async () => root.render(editor(initial)));
    await act(async () => root.render(editor(next)));
    await act(async () =>
      [...host.querySelectorAll("button")]
        .find((button) => button.textContent === "줄 더하기")!
        .click(),
    );
    expect(changes).toHaveBeenCalledWith(
      expect.objectContaining({ units: [expect.objectContaining({ kind })] }),
    );
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
