/**
 * @vitest-environment jsdom
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { SessionSummary } from "@seosoyoung/soul-ui";

import { EXECUTE_INSTRUCTION_PROMPT, PERSISTENT_INITIAL_INSTRUCTION } from "../../../packages/wire-schema/src/conversation_visibility";
import { RichSessionRow } from "./RichSessionRow";

describe("RichSessionRow model label", () => {
  it("renders the canonical model label between the agent and node", () => {
    const line = renderAgentLine(session({ modelLabel: "Claude - Opus", backend: "claude" }));

    expect([...line.querySelectorAll("span")].map((span) => span.textContent)).toEqual([
      "키키",
      "Claude - Opus",
      "eias-linegames",
    ]);
  });

  it("falls back to a human-readable backend and omits an empty separator", () => {
    expect([...renderAgentLine(session({ backend: "codex" })).querySelectorAll("span")]
      .map((span) => span.textContent)).toEqual(["키키", "Codex", "eias-linegames"]);
    expect([...renderAgentLine(session({ backend: undefined })).querySelectorAll("span")]
      .map((span) => span.textContent)).toEqual(["키키", "eias-linegames"]);
  });
});

describe("RichSessionRow preview", () => {
  const first = `${EXECUTE_INSTRUCTION_PROMPT}\n${PERSISTENT_INITIAL_INSTRUCTION}`;
  const stored = (preview: string) => ({ type: "assistant_message" as const, preview, timestamp: "2026-11-25T00:00:00Z" });

  it("shows neither a stored [SILENT] nor a first-instruction prompt", () => {
    const text = renderPreview(session({ lastMessage: stored("[SILENT]"), prompt: first }));
    expect(text).toBe("아직 표시할 메시지가 없습니다.");
    expect(text).not.toContain("[SILENT]");
  });

  it("falls to an ordinary prompt when the stored preview is [SILENT]", () => {
    expect(renderPreview(session({ lastMessage: stored("[SILENT]"), prompt: "결과를 표로 정리해줘." }))).toBe("결과를 표로 정리해줘.");
  });

  it("still shows an ordinary stored preview", () => {
    expect(renderPreview(session({ lastMessage: stored("안녕하세요"), prompt: first }))).toBe("안녕하세요");
  });
});

function renderPreview(session: SessionSummary): string {
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(<RichSessionRow session={session} onOpen={vi.fn()} />);
  return container.querySelector(".v3-run-row small")?.textContent ?? "";
}

function renderAgentLine(session: SessionSummary): Element {
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(
    <RichSessionRow session={session} onOpen={vi.fn()} />,
  );
  const line = container.querySelector(".v3-run-agent-line");
  if (!line) throw new Error("agent line was not rendered");
  return line;
}

function session(overrides: Partial<SessionSummary>): SessionSummary {
  return {
    agentSessionId: "session-a",
    status: "running",
    eventCount: 1,
    agentId: "keke",
    agentName: "키키",
    nodeId: "eias-linegames",
    createdAt: "2026-08-04T00:00:00.000Z",
    ...overrides,
  };
}
