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

  // === 통합 스키마 v1 (2026-05-07 Plan A·B·C 합의) 케이스 ===

  it("browser source v1 full 스키마: source/name/id/email/ip 5 라인", () => {
    const lines = buildCallerInfoLines({
      source: "browser",
      display_name: "서소영",
      user_id: "user@example.com",
      avatar_url: "https://lh3.googleusercontent.com/avatar.png",
      email: "user@example.com",
      ip: "1.2.3.4",
    });
    expect(lines.map((l) => l.label)).toEqual([
      "source",
      "name",
      "id",
      "email",
      "ip",
    ]);
    expect(lines[1].text).toBe("서소영");
    // browser source는 user_id의 @ 이전만 'id' 라벨에 표시 (formatUserId 적용)
    expect(lines[2].text).toBe("user");
    // email 라벨은 전체 email 표시 (의도적 중복)
    expect(lines[3].text).toBe("user@example.com");
  });

  it("slack source channel_id sub-dict (통합 스키마 v1) → channel 라벨 표시", () => {
    const lines = buildCallerInfoLines({
      source: "slack",
      user_id: "U08ABCDE",
      display_name: "Alice",
      slack: { channel_id: "C09SUBDICT", user_id: "U08ABCDE", thread_ts: "1234" },
    });
    const channelLine = lines.find((l) => l.label === "channel");
    expect(channelLine?.text).toBe("C09SUBDICT");
    // slack source는 user_id 앞 8글자
    const idLine = lines.find((l) => l.label === "id");
    expect(idLine?.text).toBe("U08ABCDE");
  });

  it("slack channel_id sub-dict 우선, top-level은 fallback (legacy 호환)", () => {
    // sub-dict와 top-level 둘 다 있을 때 sub-dict 우선
    const lines = buildCallerInfoLines({
      source: "slack",
      channel_id: "C-LEGACY",
      slack: { channel_id: "C-NEW" },
    });
    const channelLine = lines.find((l) => l.label === "channel");
    expect(channelLine?.text).toBe("C-NEW");
  });

  it("agent source + display_name 있으면 agent 라벨 생략 (중복 방지)", () => {
    const lines = buildCallerInfoLines({
      source: "agent",
      agent_node: "node-x",
      agent_id: "a1",
      agent_name: "서소영",
      display_name: "서소영",
      user_id: "a1",
    });
    expect(lines.map((l) => l.label)).toEqual([
      "source",
      "name",
      "id",
      "node",
    ]);
    // agent 라벨이 없어야 함 (display_name이 같은 값을 'name'으로 이미 표시)
    expect(lines.find((l) => l.label === "agent")).toBeUndefined();
  });

  it("legacy data graceful — 신규 필드 없는 agent caller_info (Phase 3 이전 데이터)", () => {
    const lines = buildCallerInfoLines({
      source: "agent",
      agent_node: "node-x",
      agent_id: "a1",
      agent_name: "Old Agent",
    });
    // display_name 없음 → 'name' 라벨 없음, 'agent' 라벨이 fallback으로 표시
    expect(lines.map((l) => l.label)).toEqual([
      "source",
      "node",
      "agent",
    ]);
    expect(lines[2].text).toBe("Old Agent");
  });

  it("legacy data graceful — browser caller_info에 ip만 (Phase 2a 이전 데이터)", () => {
    const lines = buildCallerInfoLines({
      source: "browser",
      ip: "1.2.3.4",
    });
    expect(lines.map((l) => l.label)).toEqual(["source", "ip"]);
  });

  it("email == user_id (browser)일 때 두 라벨 모두 표시 (의도적 중복)", () => {
    const lines = buildCallerInfoLines({
      source: "browser",
      user_id: "u@e.com",
      email: "u@e.com",
    });
    expect(lines.find((l) => l.label === "id")?.text).toBe("u");
    expect(lines.find((l) => l.label === "email")?.text).toBe("u@e.com");
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
