/**
 * @vitest-environment jsdom
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { SessionSummary } from "@seosoyoung/soul-ui";

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
