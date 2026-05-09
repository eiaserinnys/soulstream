/**
 * InterventionMessage.helpers — computeInterventionDisplay 분기 단위 테스트.
 *
 * F-11 (2026-05-09, atom F-11): system / agent / user 3분기와 displayId/portraitUrl/
 * fallbackEmoji 결정 정합 검증. soul-ui는 jsdom + @testing-library/react 인프라 부재라
 * 컴포넌트 자체 렌더 테스트는 벗어나고, 분기 로직은 helper로 분리되어 vitest node
 * 환경에서 직접 검증 (design-principles §10 인터페이스가 테스트 표면).
 */

import { describe, it, expect } from "vitest";
import { computeInterventionDisplay } from "./InterventionMessage.helpers";
import type { ChatMessage } from "../../lib/flatten-tree";
import type { ProfileConfig } from "../../stores/dashboard-store-types";

function makeMsg(partial: Partial<ChatMessage>): ChatMessage {
  return {
    id: "msg-1",
    treeNodeId: "node-1",
    treeNodeType: "intervention",
    role: "intervention",
    content: "hello",
    ...partial,
  } as ChatMessage;
}

const userConfig: ProfileConfig = {
  id: "eiaserinnys@gmail.com",
  name: "Jubok",
  hasPortrait: true,
  portraitUrl: "https://google.com/picture.jpg",
};

describe("computeInterventionDisplay — system 분기", () => {
  it("source=system이면 Soulstream 이름 + 정적 자산 portrait + ⚙️ fallback", () => {
    const msg = makeMsg({
      callerInfo: { source: "system", agent_node: "eias-shopping", display_name: "Soulstream" },
    });
    const d = computeInterventionDisplay(msg, null, userConfig);
    expect(d.isSystem).toBe(true);
    expect(d.isAgent).toBe(false);
    expect(d.displayName).toBe("Soulstream");
    expect(d.displayId).toBeNull();
    expect(d.portraitUrl).toBe("/system-portrait.png");
    expect(d.hasPortrait).toBe(true);
    expect(d.fallbackEmoji).toBe("\u{2699}\u{FE0F}");
  });

  it("system + display_name 누락 시 'Soulstream' 기본값", () => {
    const msg = makeMsg({
      callerInfo: { source: "system", agent_node: "eias-shopping" },
    });
    const d = computeInterventionDisplay(msg, null, userConfig);
    expect(d.displayName).toBe("Soulstream");
  });

  it("system이면 agentInfo가 있어도 system이 우선 (system 발신은 agent 분기 안 들어감)", () => {
    const msg = makeMsg({
      callerInfo: { source: "system", agent_node: "eias-shopping" },
      agentInfo: { source: "agent", agent_node: "eias", agent_id: "shay", agent_name: "Shay" },
    });
    const d = computeInterventionDisplay(msg, null, userConfig);
    expect(d.isSystem).toBe(true);
    expect(d.isAgent).toBe(false);
    expect(d.displayName).toBe("Soulstream"); // agent 이름 아님
  });
});

describe("computeInterventionDisplay — agent 분기 (회귀 보존)", () => {
  it("agentInfo 있고 system 아니면 agent 이름 + 노드 프록시 portrait", () => {
    const msg = makeMsg({
      agentInfo: { source: "agent", agent_node: "eias", agent_id: "shay", agent_name: "Shay" },
    });
    const d = computeInterventionDisplay(msg, null, userConfig);
    expect(d.isAgent).toBe(true);
    expect(d.displayName).toBe("Shay");
    expect(d.displayId).toBe("Shay@eias");
    expect(d.portraitUrl).toBe("/api/nodes/eias/agents/shay/portrait");
    expect(d.fallbackEmoji).toBe("\u{1F916}");
  });

  it("agentInfo agent_id null이면 portrait null + fallback emoji 표시", () => {
    const msg = makeMsg({
      agentInfo: { source: "agent", agent_node: "eias", agent_id: null, agent_name: "Anon" },
    });
    const d = computeInterventionDisplay(msg, null, userConfig);
    expect(d.portraitUrl).toBeNull();
    expect(d.hasPortrait).toBe(false);
  });
});

describe("computeInterventionDisplay — user 분기 (회귀 보존)", () => {
  it("callerInfo.display_name 우선, 없으면 userConfig.name", () => {
    const msg = makeMsg({
      callerInfo: { source: "slack", display_name: "Alice" },
    });
    const d = computeInterventionDisplay(msg, null, userConfig);
    expect(d.isSystem).toBe(false);
    expect(d.isAgent).toBe(false);
    expect(d.displayName).toBe("Alice");
    expect(d.displayId).toBe(userConfig.id);
    expect(d.fallbackEmoji).toBe("\u{270B}");
  });

  it("callerInfo 부재 시 userConfig.name fallback", () => {
    const msg = makeMsg({});
    const d = computeInterventionDisplay(msg, null, userConfig);
    expect(d.displayName).toBe("Jubok");
  });

  it("userConfig.name='USER' (default sentinel)이면 'Intervention' fallback", () => {
    const msg = makeMsg({});
    const userDefault: ProfileConfig = { id: "x", name: "USER", hasPortrait: false, portraitUrl: null };
    const d = computeInterventionDisplay(msg, null, userDefault);
    expect(d.displayName).toBe("Intervention");
  });
});
