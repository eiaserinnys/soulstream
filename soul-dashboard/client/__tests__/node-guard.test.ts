/**
 * node-guard.test.ts - 다른 노드 세션 판별 로직 테스트
 *
 * computeIsOtherNode 함수가 DashboardLayout의 chatInputDisabled 주입 조건을
 * 올바르게 계산하는지 검증한다.
 */

import { describe, it, expect } from "vitest";
import { computeIsOtherNode } from "../lib/node-guard";

describe("computeIsOtherNode", () => {
  // ──────────────────────────────────────────────
  // 비활성화 케이스: 다른 노드 세션 → chatInputDisabled=true
  // ──────────────────────────────────────────────

  it("세션 nodeId가 현재 nodeId와 다르면 true (chatInputDisabled=true)", () => {
    expect(computeIsOtherNode("node-A", "node-B")).toBe(true);
  });

  // ──────────────────────────────────────────────
  // 활성화 케이스: 같은 노드 세션 → chatInputDisabled=false
  // ──────────────────────────────────────────────

  it("세션 nodeId가 현재 nodeId와 같으면 false (chatInputDisabled=false)", () => {
    expect(computeIsOtherNode("node-A", "node-A")).toBe(false);
  });

  // ──────────────────────────────────────────────
  // 판단 유보 케이스 → chatInputDisabled=false
  // ──────────────────────────────────────────────

  it("currentNodeId가 undefined이면 false (fetch 실패 → 판단 유보)", () => {
    expect(computeIsOtherNode(undefined, "node-B")).toBe(false);
  });

  it("sessionNodeId가 null이면 false (node_id 미기록 세션 → 하위 호환)", () => {
    expect(computeIsOtherNode("node-A", null)).toBe(false);
  });

  it("sessionNodeId가 undefined이면 false (node_id 미기록 세션 → 하위 호환)", () => {
    expect(computeIsOtherNode("node-A", undefined)).toBe(false);
  });

  it("currentNodeId와 sessionNodeId 모두 undefined이면 false", () => {
    expect(computeIsOtherNode(undefined, undefined)).toBe(false);
  });
});
