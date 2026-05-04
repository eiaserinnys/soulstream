/**
 * session-metadata-helpers 단위 테스트.
 *
 * 컴포넌트 렌더 의존 없이 순수 함수만 검증.
 */

import { describe, it, expect } from "vitest";
import { buildCallerInfoLines, getDedupKey } from "./session-metadata-helpers";

describe("buildCallerInfoLines", () => {
  it("callerSessionId 1급 필드로 parent 라인을 생성", () => {
    const lines = buildCallerInfoLines(
      {
        source: "agent",
        agent_node: "eiaserinnys",
        agent_id: "agent-x",
        agent_name: "서소영",
      },
      "sess-abcdef1234567890",
    );
    expect(lines.map((l) => l.label)).toEqual([
      "source",
      "parent",
      "node",
      "agent",
    ]);
    expect(lines[0].text).toBe("agent");
    // parent는 8자로 잘림
    expect(lines[1].text).toBe("sess-abc");
    expect(lines[2].text).toBe("eiaserinnys");
    // agent_name이 있으면 agent_id보다 우선
    expect(lines[3].text).toBe("서소영");
  });

  it("callerSessionId 없으면 caller_info.parent_session_id fallback (레거시 호환)", () => {
    const lines = buildCallerInfoLines({
      source: "agent",
      parent_session_id: "sess-legacy1234567890",
      agent_node: "eiaserinnys",
    });
    const parentLine = lines.find((l) => l.label === "parent");
    expect(parentLine?.text).toBe("sess-leg");
  });

  it("callerSessionId가 caller_info.parent_session_id보다 우선", () => {
    const lines = buildCallerInfoLines(
      { source: "agent", parent_session_id: "sess-old0000" },
      "sess-new1111",
    );
    const parentLine = lines.find((l) => l.label === "parent");
    expect(parentLine?.text).toBe("sess-new");
  });

  it("source=browser + ip 케이스에서 ip 라벨이 포함됨", () => {
    const lines = buildCallerInfoLines({
      source: "browser",
      ip: "61.74.154.79",
    });
    expect(lines.map((l) => l.label)).toEqual(["source", "ip"]);
    expect(lines[0].text).toBe("browser");
    expect(lines[1].text).toBe("61.74.154.79");
  });

  it("source=slack + channel_id 케이스에서 channel 라벨이 포함됨", () => {
    const lines = buildCallerInfoLines({
      source: "slack",
      channel_id: "C08ABC123",
    });
    expect(lines.map((l) => l.label)).toEqual(["source", "channel"]);
    expect(lines[1].text).toBe("C08ABC123");
  });

  it("agent_id만 있고 agent_name이 없으면 agent_id를 표시", () => {
    const lines = buildCallerInfoLines({
      source: "agent",
      agent_id: "agent-y",
    });
    const agentLine = lines.find((l) => l.label === "agent");
    expect(agentLine?.text).toBe("agent-y");
  });

  it("빈 객체는 source: 'unknown' 한 줄만 반환", () => {
    const lines = buildCallerInfoLines({});
    expect(lines).toEqual([{ label: "source", text: "unknown" }]);
  });
});

describe("getDedupKey", () => {
  it("string 입력은 그대로 반환", () => {
    expect(getDedupKey("path/to/file.ts")).toBe("path/to/file.ts");
  });

  it("객체 입력은 JSON.stringify 결과를 반환", () => {
    const obj = { a: 1, b: "two" };
    expect(getDedupKey(obj)).toBe(JSON.stringify(obj));
  });

  it("같은 객체는 같은 key", () => {
    const k1 = getDedupKey({ source: "agent", agent_id: "x" });
    const k2 = getDedupKey({ source: "agent", agent_id: "x" });
    expect(k1).toBe(k2);
  });

  it("다른 객체는 다른 key", () => {
    const k1 = getDedupKey({ source: "agent", agent_id: "x" });
    const k2 = getDedupKey({ source: "browser", ip: "1.2.3.4" });
    expect(k1).not.toBe(k2);
  });

  it("빈 string과 빈 객체는 다른 key", () => {
    expect(getDedupKey("")).not.toBe(getDedupKey({}));
  });
});
