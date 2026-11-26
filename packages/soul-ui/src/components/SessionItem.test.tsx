/**
 * @vitest-environment jsdom
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { SessionSummary } from "../shared/types";
import { SessionItem, getSessionStatusLabel } from "./SessionItem";

describe("getSessionStatusLabel", () => {
  it("calls a finished agent turn 턴 종료", () => {
    expect(getSessionStatusLabel("completed", "claude")).toBe("턴 종료");
    expect(getSessionStatusLabel("completed", undefined)).toBe("턴 종료");
  });

  it("keeps 완료 for a finished llm session", () => {
    expect(getSessionStatusLabel("completed", "llm")).toBe("완료");
  });

  it("keeps the STATUS_CONFIG label for every other status", () => {
    expect(getSessionStatusLabel("running", "claude")).toBe("실행 중");
    expect(getSessionStatusLabel("error", "claude")).toBe("오류");
    expect(getSessionStatusLabel("interrupted", "llm")).toBe("중단");
    expect(getSessionStatusLabel("unknown", "claude")).toBe("대기");
  });
});

describe("SessionItem status chip", () => {
  const render = (overrides: Partial<SessionSummary>) => renderToStaticMarkup(
    <SessionItem
      session={{ agentSessionId: "s", status: "completed", eventCount: 0, createdAt: "2026-11-26T00:00:00Z", ...overrides }}
      isActive={false}
      isSelected={false}
      isEditing={false}
      dragSessionIds={["s"]}
      onClick={() => undefined}
      onContextMenu={() => undefined}
      onEditSubmit={() => undefined}
      onEditCancel={() => undefined}
    />,
  );

  it("shows 턴 종료 for a completed agent session and 완료 for a completed llm session", () => {
    expect(render({ sessionType: "claude" })).toContain("턴 종료");
    const llm = render({ sessionType: "llm" });
    expect(llm).toContain("완료");
    expect(llm).not.toContain("턴 종료");
  });
});
