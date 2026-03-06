/**
 * CLI Test Runner — 트리 검증 엔진
 *
 * processEvent()가 구성한 EventTreeNode 트리의 구조적 무결성을 검증합니다.
 * 순수 함수로 구성되어 외부 의존 없이 동작합니다.
 */

import type { EventTreeNode } from "@shared/types";

// === Validation Result Types ===

export interface ValidationResult {
  name: string;
  passed: boolean;
  details: string[];
  /** 경고 (패스했지만 주의가 필요한 항목) */
  warnings: string[];
}

export interface TreeStats {
  totalNodes: number;
  byType: Record<string, number>;
  maxDepth: number;
  orphanCount: number;
  streamingCount: number;
}

export interface ReplayReport {
  sessionFile: string;
  eventCount: number;
  treeStats: TreeStats;
  validations: ValidationResult[];
  passed: boolean;
  timestamp: string;
}

// === Tree Traversal Helpers ===

/** DFS로 트리의 모든 노드를 수집합니다 (루트 포함). */
export function collectAllNodes(root: EventTreeNode): EventTreeNode[] {
  const result: EventTreeNode[] = [root];
  for (const child of root.children) {
    result.push(...collectAllNodes(child));
  }
  return result;
}

/** 트리의 최대 깊이를 계산합니다. */
export function getMaxDepth(node: EventTreeNode, depth = 0): number {
  if (node.children.length === 0) return depth;
  return Math.max(...node.children.map((c) => getMaxDepth(c, depth + 1)));
}

/** 노드 타입별 카운트를 집계합니다. */
export function countByType(nodes: EventTreeNode[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const node of nodes) {
    counts[node.type] = (counts[node.type] ?? 0) + 1;
  }
  return counts;
}

// === Validation Functions ===

/**
 * V1: 트리 무결성 — 모든 노드가 정확히 하나의 부모를 가지는지 검증합니다.
 *
 * 같은 노드가 두 부모의 children에 동시에 존재하면 트리가 아니라 DAG가 되며
 * DFS 순회 시 무한 루프나 중복 렌더링이 발생합니다.
 */
export function validateTreeIntegrity(root: EventTreeNode): ValidationResult {
  const result: ValidationResult = {
    name: "V1: 트리 무결성 (단일 부모)",
    passed: true,
    details: [],
    warnings: [],
  };

  const seen = new Map<string, string>(); // nodeId → parentId

  function walk(node: EventTreeNode, parentId: string | null) {
    if (seen.has(node.id)) {
      result.passed = false;
      result.details.push(
        `노드 "${node.id}" (${node.type})가 다중 부모를 가짐: ` +
          `"${seen.get(node.id)}" + "${parentId}"`,
      );
      return;
    }
    seen.set(node.id, parentId ?? "(root)");
    for (const child of node.children) {
      walk(child, node.id);
    }
  }

  walk(root, null);

  if (result.passed) {
    result.details.push(`${seen.size}개 노드 모두 단일 부모 확인`);
  }
  return result;
}

/**
 * V2: thinking→text 연결 — thinking 노드에 textContent가 올바르게 병합되었는지 검증합니다.
 *
 * parent_tool_use_id 기반으로 thinking과 text_start가 같은 부모 레벨에서 매칭되어
 * text_delta의 내용이 thinking 노드의 textContent로 병합되어야 합니다.
 * 매칭 실패 시 thinking에 텍스트가 없고 독립 text 노드가 생기며
 * textCompleted 플래그도 설정되지 않습니다.
 */
export function validateThinkingTextConnections(
  root: EventTreeNode,
  events: Array<{ id: number; event: Record<string, unknown> }>,
): ValidationResult {
  const result: ValidationResult = {
    name: "V2: thinking→text 연결 (parent_tool_use_id 기반)",
    passed: true,
    details: [],
    warnings: [],
  };

  // 이벤트 시퀀스에서 thinking → text_start 쌍 검증
  const thinkingEvents: Array<{ eventId: number; parentToolUseId: string | null }> = [];
  const textStartEvents: Array<{ eventId: number; parentToolUseId: string | null }> = [];

  for (const record of events) {
    const evt = record.event;
    if (evt.type === "thinking") {
      thinkingEvents.push({
        eventId: record.id,
        parentToolUseId: (evt.parent_tool_use_id as string | null) ?? null,
      });
    }
    if (evt.type === "text_start") {
      textStartEvents.push({
        eventId: record.id,
        parentToolUseId: (evt.parent_tool_use_id as string | null) ?? null,
      });
    }
  }

  // 트리에서 thinking 노드의 textContent 검증
  const allNodes = collectAllNodes(root);
  const thinkingNodes = allNodes.filter((n) => n.type === "thinking");

  // textContent가 있는 thinking (정상 매칭)
  const linkedThinking = thinkingNodes.filter(
    (n) => n.textContent !== undefined && n.textContent !== null,
  );
  // textContent가 없는 thinking (매칭 실패 또는 thinking-only)
  const unlinkedThinking = thinkingNodes.filter(
    (n) => n.textContent === undefined || n.textContent === null,
  );

  // textCompleted 검증 — 매칭된 thinking에 textCompleted가 설정되었는지
  const incompleteLinked = linkedThinking.filter((n) => !n.textCompleted);
  if (incompleteLinked.length > 0) {
    result.passed = false;
    result.details.push(
      `thinking 노드 ${incompleteLinked.length}개에 textContent가 있으나 textCompleted=false: ` +
        incompleteLinked.map((n) => n.id).slice(0, 5).join(", ") +
        (incompleteLinked.length > 5 ? ` ... 외 ${incompleteLinked.length - 5}개` : ""),
    );
  }

  // thinking 없이 생성된 독립 text 노드 개수 확인
  const independentTextNodes = allNodes.filter((n) => n.type === "text");
  if (independentTextNodes.length > 0 && thinkingNodes.length > 0) {
    // thinking이 있는 세션에서 독립 text가 있으면 경고 (매칭 실패 가능)
    result.warnings.push(
      `독립 text 노드 ${independentTextNodes.length}개 존재 (thinking 매칭 실패 가능)`,
    );
  }

  if (unlinkedThinking.length > 0) {
    result.warnings.push(
      `thinking 노드 ${unlinkedThinking.length}개에 textContent가 없음 ` +
        `(thinking-only이거나 text 매칭 실패): ${unlinkedThinking.map((n) => n.id).slice(0, 5).join(", ")}` +
        (unlinkedThinking.length > 5 ? ` ... 외 ${unlinkedThinking.length - 5}개` : ""),
    );
  }

  if (result.passed) {
    result.details.push(
      `thinking ${thinkingNodes.length}개 (linked: ${linkedThinking.length}, unlinked: ${unlinkedThinking.length}), ` +
        `text_start ${textStartEvents.length}개, 독립 text 노드 ${independentTextNodes.length}개`,
    );
  }

  return result;
}

/**
 * V3: tool_use_id 연결 — tool_start → tool_result 매칭을 검증합니다.
 *
 * tool_start에서 tool_use_id가 발급되고, tool_result에서 같은 ID로 노드를 찾아
 * 결과를 반영합니다. 매칭 실패 시 도구 결과가 유실됩니다.
 */
export function validateToolConnections(
  events: Array<{ id: number; event: Record<string, unknown> }>,
): ValidationResult {
  const result: ValidationResult = {
    name: "V3: tool_use_id 연결 (tool_start → tool_result)",
    passed: true,
    details: [],
    warnings: [],
  };

  const toolStarts = new Map<string, number>(); // tool_use_id → eventId
  const toolResults = new Map<string, number>(); // tool_use_id → eventId

  for (const record of events) {
    const evt = record.event;
    if (evt.type === "tool_start" && evt.tool_use_id) {
      toolStarts.set(evt.tool_use_id as string, record.id);
    }
    if (evt.type === "tool_result" && evt.tool_use_id) {
      toolResults.set(evt.tool_use_id as string, record.id);
    }
  }

  // tool_start는 있는데 tool_result가 없는 경우
  const unmatched: string[] = [];
  for (const [toolUseId, eventId] of toolStarts) {
    if (!toolResults.has(toolUseId)) {
      unmatched.push(`${toolUseId} (start: id=${eventId})`);
    }
  }

  if (unmatched.length > 0) {
    // 세션이 완료되지 않았을 수 있으므로 경고로 처리
    result.warnings.push(
      `tool_start ${unmatched.length}개에 tool_result 없음: ${unmatched.join(", ")}`,
    );
  }

  // tool_result는 있는데 tool_start가 없는 경우 (심각한 오류)
  const orphanResults: string[] = [];
  for (const [toolUseId, eventId] of toolResults) {
    if (!toolStarts.has(toolUseId)) {
      orphanResults.push(`${toolUseId} (result: id=${eventId})`);
    }
  }

  if (orphanResults.length > 0) {
    result.passed = false;
    result.details.push(
      `tool_result ${orphanResults.length}개에 대응하는 tool_start 없음: ` +
        orphanResults.join(", "),
    );
  }

  if (result.passed && unmatched.length === 0) {
    result.details.push(
      `tool_start ${toolStarts.size}개, tool_result ${toolResults.size}개 — 모든 ID 정상 매칭`,
    );
  }

  return result;
}

/**
 * V4: 고아 노드 감지 — 세션 루트 직하에 배치된 노드 중
 * user_message/intervention/complete/error 외의 노드를 감지합니다.
 *
 * 설계상 세션 루트의 직접 자식은 턴 루트(user_message, intervention)와
 * 세션 레벨 complete/error만 허용됩니다. 그 외의 노드가 루트에 직접 붙어 있으면
 * 부모 결정 실패(고아)를 의미합니다.
 */
export function detectOrphanNodes(root: EventTreeNode): ValidationResult {
  const result: ValidationResult = {
    name: "V4: 고아 노드 감지",
    passed: true,
    details: [],
    warnings: [],
  };

  const allowedRootChildTypes = new Set([
    "user_message",
    "intervention",
    "complete",
    "error",
  ]);

  const orphans: EventTreeNode[] = [];
  for (const child of root.children) {
    if (!allowedRootChildTypes.has(child.type)) {
      orphans.push(child);
    }
  }

  if (orphans.length > 0) {
    // subagent 노드가 루트에 붙는 것은 현재 SDK 한계로 인한 알려진 동작
    const subagentOrphans = orphans.filter((n) => n.type === "subagent");
    const otherOrphans = orphans.filter((n) => n.type !== "subagent");

    if (subagentOrphans.length > 0) {
      result.warnings.push(
        `subagent 노드 ${subagentOrphans.length}개가 세션 루트에 직접 배치 ` +
          `(SDK 한계 — 알려진 동작): ${subagentOrphans.map((n) => n.id).join(", ")}`,
      );
    }

    if (otherOrphans.length > 0) {
      result.passed = false;
      result.details.push(
        `세션 루트에 비정상 노드 ${otherOrphans.length}개 감지: ` +
          otherOrphans.map((n) => `"${n.id}" (${n.type})`).join(", "),
      );
    }
  }

  if (result.passed && orphans.length === 0) {
    result.details.push(
      `세션 루트 자식 ${root.children.length}개 모두 정상 (turn root 또는 session-level)`,
    );
  }

  return result;
}

/**
 * V5: 스트리밍 완료 — 세션 완료 후 모든 노드의 completed=true를 확인합니다.
 *
 * 세션이 정상 종료(complete/result 이벤트 수신)된 후에는
 * 트리의 모든 노드가 completed 상태여야 합니다.
 * 미완료 노드가 있으면 "(streaming...)" 상태로 영원히 남습니다.
 */
export function validateStreamingComplete(
  root: EventTreeNode,
  sessionCompleted: boolean,
): ValidationResult {
  const result: ValidationResult = {
    name: "V5: 스트리밍 완료 확인",
    passed: true,
    details: [],
    warnings: [],
  };

  if (!sessionCompleted) {
    result.warnings.push("세션이 완료되지 않아 스트리밍 완료 검증을 건너뜁니다");
    return result;
  }

  const allNodes = collectAllNodes(root);
  const incompleteNodes = allNodes.filter((n) => !n.completed);

  // session root 자체는 completed=false일 수 있음
  const meaningfulIncomplete = incompleteNodes.filter(
    (n) => n.type !== "session",
  );

  if (meaningfulIncomplete.length > 0) {
    result.passed = false;
    result.details.push(
      `미완료 노드 ${meaningfulIncomplete.length}개: ` +
        meaningfulIncomplete
          .map((n) => `"${n.id}" (${n.type})`)
          .slice(0, 10)
          .join(", ") +
        (meaningfulIncomplete.length > 10
          ? ` ... 외 ${meaningfulIncomplete.length - 10}개`
          : ""),
    );
  } else {
    result.details.push(
      `세션 완료 — 모든 노드(${allNodes.length}개) completed=true 확인`,
    );
  }

  return result;
}

/**
 * V6: 그래프 생성 — buildGraph() 결과의 유효성을 검증합니다.
 *
 * 노드/엣지 수가 0이 아닌지, 위치 값이 유효한지 확인합니다.
 */
export function validateGraphGeneration(
  graphResult: { nodes: unknown[]; edges: unknown[] } | null,
): ValidationResult {
  const result: ValidationResult = {
    name: "V6: 그래프 생성 유효성",
    passed: true,
    details: [],
    warnings: [],
  };

  if (!graphResult) {
    result.passed = false;
    result.details.push("buildGraph() 결과가 null");
    return result;
  }

  const { nodes, edges } = graphResult;

  if (nodes.length === 0) {
    result.passed = false;
    result.details.push("생성된 그래프 노드가 0개");
    return result;
  }

  // 노드 위치 유효성 (NaN이나 Infinity 체크)
  let invalidPositions = 0;
  for (const node of nodes as Array<{ position?: { x: number; y: number } }>) {
    if (node.position) {
      if (
        !Number.isFinite(node.position.x) ||
        !Number.isFinite(node.position.y)
      ) {
        invalidPositions++;
      }
    }
  }

  if (invalidPositions > 0) {
    result.passed = false;
    result.details.push(
      `그래프 노드 ${invalidPositions}개의 위치가 유효하지 않음 (NaN/Infinity)`,
    );
  }

  result.details.push(
    `그래프 생성 완료: 노드 ${nodes.length}개, 엣지 ${edges.length}개`,
  );

  return result;
}

// === Tree Statistics ===

/** 트리 통계를 계산합니다. */
export function computeTreeStats(root: EventTreeNode): TreeStats {
  const allNodes = collectAllNodes(root);
  const byType = countByType(allNodes);
  const maxDepth = getMaxDepth(root);

  const allowedRootChildTypes = new Set([
    "user_message",
    "intervention",
    "complete",
    "error",
  ]);
  const orphanCount = root.children.filter(
    (c) => !allowedRootChildTypes.has(c.type),
  ).length;

  const streamingCount = allNodes.filter(
    (n) => !n.completed && n.type !== "session",
  ).length;

  return {
    totalNodes: allNodes.length,
    byType,
    maxDepth,
    orphanCount,
    streamingCount,
  };
}

// === Report Formatting ===

/** 검증 리포트를 콘솔에 출력합니다. */
export function printReport(report: ReplayReport): void {
  console.log("\n" + "=".repeat(70));
  console.log("  CLI Tree Validation Report");
  console.log("=".repeat(70));
  console.log(`  Session: ${report.sessionFile}`);
  console.log(`  Events:  ${report.eventCount}`);
  console.log(`  Time:    ${report.timestamp}`);
  console.log("-".repeat(70));

  // Tree Stats
  console.log("\n  [Tree Statistics]");
  console.log(`    Total nodes:     ${report.treeStats.totalNodes}`);
  console.log(`    Max depth:       ${report.treeStats.maxDepth}`);
  console.log(`    Orphan nodes:    ${report.treeStats.orphanCount}`);
  console.log(`    Streaming nodes: ${report.treeStats.streamingCount}`);
  console.log("    By type:");
  for (const [type, count] of Object.entries(report.treeStats.byType).sort()) {
    console.log(`      ${type.padEnd(20)} ${count}`);
  }

  // Validations
  console.log("\n  [Validations]");
  for (const v of report.validations) {
    const icon = v.passed ? "PASS" : "FAIL";
    const color = v.passed ? "\x1b[32m" : "\x1b[31m";
    console.log(`\n    ${color}[${icon}]\x1b[0m ${v.name}`);
    for (const d of v.details) {
      console.log(`           ${d}`);
    }
    for (const w of v.warnings) {
      console.log(`           \x1b[33m⚠ ${w}\x1b[0m`);
    }
  }

  // Summary
  console.log("\n" + "-".repeat(70));
  const failCount = report.validations.filter((v) => !v.passed).length;
  const warnCount = report.validations.reduce(
    (acc, v) => acc + v.warnings.length,
    0,
  );
  if (report.passed) {
    console.log(
      `  \x1b[32m✓ ALL PASSED\x1b[0m (${report.validations.length} validations, ${warnCount} warnings)`,
    );
  } else {
    console.log(
      `  \x1b[31m✗ ${failCount} FAILED\x1b[0m out of ${report.validations.length} validations, ${warnCount} warnings`,
    );
  }
  console.log("=".repeat(70) + "\n");
}

// === Baseline Snapshot ===

/** 트리 구조를 직렬화 가능한 형태로 변환합니다. */
export interface BaselineSnapshot {
  sessionFile: string;
  createdAt: string;
  treeStats: TreeStats;
  /** 트리 구조 요약 (노드 ID, 타입, 자식 수만 포함) */
  treeStructure: TreeNodeSummary[];
  validationResults: Array<{
    name: string;
    passed: boolean;
    detailCount: number;
    warningCount: number;
  }>;
}

export interface TreeNodeSummary {
  id: string;
  type: string;
  childCount: number;
  completed: boolean;
  children: TreeNodeSummary[];
}

/** 트리를 직렬화 가능한 요약 구조로 변환합니다. */
export function summarizeTree(node: EventTreeNode): TreeNodeSummary {
  return {
    id: node.id,
    type: node.type,
    childCount: node.children.length,
    completed: node.completed,
    children: node.children.map(summarizeTree),
  };
}

/** baseline 스냅샷을 생성합니다. */
export function createBaselineSnapshot(
  sessionFile: string,
  root: EventTreeNode,
  report: ReplayReport,
): BaselineSnapshot {
  return {
    sessionFile,
    createdAt: new Date().toISOString(),
    treeStats: report.treeStats,
    treeStructure: [summarizeTree(root)],
    validationResults: report.validations.map((v) => ({
      name: v.name,
      passed: v.passed,
      detailCount: v.details.length,
      warningCount: v.warnings.length,
    })),
  };
}
