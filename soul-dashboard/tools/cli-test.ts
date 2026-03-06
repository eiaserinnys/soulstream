/**
 * CLI Test App — 세션 데이터 리플레이 & 트리 검증
 *
 * SSE 이벤트 → processEvent() → 트리 빌드 → buildGraph() 전체 파이프라인을
 * 브라우저 없이 검증합니다.
 *
 * 실행 방법:
 *   npx vite-node tools/cli-test.ts [session-file.jsonl] [--baseline]
 *
 * 예시:
 *   npx vite-node tools/cli-test.ts ../../soulstream_runtime/.local/data/events/sess-*.jsonl
 *   npx vite-node tools/cli-test.ts --all --baseline
 *
 * vite-node은 Vite의 모듈 해석(@shared/ 등)을 그대로 사용하므로
 * 별도의 path alias 설정 없이 동작합니다.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "fs";
import { resolve, basename, dirname } from "path";
import { fileURLToPath } from "url";

// Node.js 환경에서 zustand persist가 localStorage를 찾지 못해 경고를 대량 출력합니다.
// store import 전에 console.warn을 래핑하여 zustand persist 경고를 필터합니다.
const _originalWarn = console.warn;
console.warn = (...args: unknown[]) => {
  const msg = String(args[0] ?? "");
  if (msg.includes("[zustand persist middleware]")) return;
  _originalWarn(...args);
};

import { useDashboardStore } from "../client/stores/dashboard-store";
import { buildGraph } from "../client/lib/layout-engine";
import type { SoulSSEEvent } from "@shared/types";
import {
  validateTreeIntegrity,
  validateThinkingTextConnections,
  validateToolConnections,
  detectOrphanNodes,
  validateStreamingComplete,
  validateGraphGeneration,
  computeTreeStats,
  printReport,
  createBaselineSnapshot,
  type ReplayReport,
} from "./cli-test-runner";

// === Configuration ===

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** soulstream_runtime 이벤트 디렉토리 (기본 세션 데이터 경로) */
const DEFAULT_EVENTS_DIR =
  process.env.SOUL_EVENTS_DIR ??
  resolve(__dirname, "../../../../../soulstream_runtime/.local/data/events");

/** baseline 스냅샷 저장 경로 */
const BASELINE_DIR = resolve(__dirname, "../.baselines");

// === Event Record ===

interface EventRecord {
  id: number;
  event: Record<string, unknown>;
}

// === JSONL Parser ===

/** JSONL 파일을 읽어 EventRecord 배열로 파싱합니다. */
function readJsonl(filePath: string): EventRecord[] {
  const content = readFileSync(filePath, "utf-8");
  const records: EventRecord[] = [];

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as EventRecord);
    } catch {
      console.warn(`  ⚠ JSONL 파싱 실패 (건너뜀): ${trimmed.slice(0, 80)}...`);
    }
  }

  return records;
}

// === Replay Engine ===

/** 세션 데이터를 replay하여 트리를 구성하고 검증 리포트를 생성합니다. */
function replaySession(
  filePath: string,
  records: EventRecord[],
): ReplayReport {
  // 스토어 초기화
  const store = useDashboardStore;
  store.getState().reset();

  // processEvent 이벤트가 아닌 것은 건너뜀
  const processableTypes = new Set([
    "user_message",
    "session",
    "intervention_sent",
    "thinking",
    "text_start",
    "text_delta",
    "text_end",
    "subagent_start",
    "subagent_stop",
    "tool_start",
    "tool_result",
    "complete",
    "error",
    "result",
  ]);

  let processedCount = 0;
  for (const record of records) {
    const eventType = record.event.type as string;
    if (processableTypes.has(eventType)) {
      store.getState().processEvent(
        record.event as SoulSSEEvent,
        record.id,
      );
      processedCount++;
    }
  }

  const tree = store.getState().tree;
  if (!tree) {
    return {
      sessionFile: basename(filePath),
      eventCount: records.length,
      treeStats: {
        totalNodes: 0,
        byType: {},
        maxDepth: 0,
        orphanCount: 0,
        streamingCount: 0,
      },
      validations: [
        {
          name: "트리 생성",
          passed: false,
          details: [
            `${records.length}개 이벤트 처리 후 트리가 null ` +
              `(processable: ${processedCount})`,
          ],
          warnings: [],
        },
      ],
      passed: false,
      timestamp: new Date().toISOString(),
    };
  }

  // 세션 완료 여부 판정
  const hasComplete = records.some(
    (r) => r.event.type === "complete" || r.event.type === "result",
  );

  // 검증 실행
  const validations = [
    validateTreeIntegrity(tree),
    validateThinkingTextConnections(tree, records),
    validateToolConnections(records),
    detectOrphanNodes(tree),
    validateStreamingComplete(tree, hasComplete),
  ];

  // buildGraph 검증
  let graphResult: { nodes: unknown[]; edges: unknown[] } | null = null;
  try {
    graphResult = buildGraph(tree, new Set());
  } catch (err) {
    validations.push({
      name: "V6: 그래프 생성 유효성",
      passed: false,
      details: [`buildGraph() 실행 중 오류: ${err}`],
      warnings: [],
    });
  }
  if (graphResult) {
    validations.push(validateGraphGeneration(graphResult));
  }

  const treeStats = computeTreeStats(tree);
  const allPassed = validations.every((v) => v.passed);

  return {
    sessionFile: basename(filePath),
    eventCount: records.length,
    treeStats,
    validations,
    passed: allPassed,
    timestamp: new Date().toISOString(),
  };
}

// === CLI Entry Point ===

// vite-node이 모듈을 중복 실행하는 것을 방지합니다.
const CLI_RUN_GUARD = Symbol.for("cli-test-executed");
if ((globalThis as Record<symbol, boolean>)[CLI_RUN_GUARD]) {
  // 이미 실행됨 — 조용히 종료
  process.exit(0);
}
(globalThis as Record<symbol, boolean>)[CLI_RUN_GUARD] = true;

function main() {
  const args = process.argv.slice(2);
  const saveBaseline = args.includes("--baseline");
  const runAll = args.includes("--all");
  const filePaths = args.filter((a) => !a.startsWith("--"));

  let sessionFiles: string[] = [];

  if (runAll) {
    // 모든 세션 파일 검증
    if (!existsSync(DEFAULT_EVENTS_DIR)) {
      console.error(`이벤트 디렉토리를 찾을 수 없습니다: ${DEFAULT_EVENTS_DIR}`);
      process.exit(1);
    }
    sessionFiles = readdirSync(DEFAULT_EVENTS_DIR)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => resolve(DEFAULT_EVENTS_DIR, f));
  } else if (filePaths.length > 0) {
    // 지정된 파일만 검증
    sessionFiles = filePaths.map((f) => resolve(f));
  } else {
    // 가장 최근 세션 파일 1개
    if (!existsSync(DEFAULT_EVENTS_DIR)) {
      console.error(
        "사용법: npx vite-node tools/cli-test.ts [session-file.jsonl] [--all] [--baseline]",
      );
      process.exit(1);
    }
    const files = readdirSync(DEFAULT_EVENTS_DIR)
      .filter((f) => f.endsWith(".jsonl"))
      .sort()
      .reverse();
    if (files.length === 0) {
      console.error("세션 데이터가 없습니다.");
      process.exit(1);
    }
    sessionFiles = [resolve(DEFAULT_EVENTS_DIR, files[0])];
  }

  console.log(`\n총 ${sessionFiles.length}개 세션 파일 검증 시작...\n`);

  let totalPassed = 0;
  let totalFailed = 0;

  for (const filePath of sessionFiles) {
    if (!existsSync(filePath)) {
      console.error(`파일을 찾을 수 없습니다: ${filePath}`);
      totalFailed++;
      continue;
    }

    const records = readJsonl(filePath);
    if (records.length === 0) {
      console.warn(`빈 파일 건너뜀: ${basename(filePath)}`);
      continue;
    }

    const report = replaySession(filePath, records);
    printReport(report);

    if (report.passed) {
      totalPassed++;
    } else {
      totalFailed++;
    }

    // baseline 저장
    if (saveBaseline) {
      const tree = useDashboardStore.getState().tree;
      if (tree) {
        if (!existsSync(BASELINE_DIR)) {
          mkdirSync(BASELINE_DIR, { recursive: true });
        }
        const snapshot = createBaselineSnapshot(basename(filePath), tree, report);
        const outPath = resolve(
          BASELINE_DIR,
          `${basename(filePath, ".jsonl")}.baseline.json`,
        );
        writeFileSync(outPath, JSON.stringify(snapshot, null, 2), "utf-8");
        console.log(`  📦 Baseline 저장: ${outPath}\n`);
      }
    }
  }

  // 전체 요약
  if (sessionFiles.length > 1) {
    console.log("\n" + "=".repeat(70));
    console.log("  Summary");
    console.log("=".repeat(70));
    console.log(`  Total:  ${sessionFiles.length}`);
    console.log(`  Passed: ${totalPassed}`);
    console.log(`  Failed: ${totalFailed}`);
    console.log("=".repeat(70) + "\n");
  }

  process.exit(totalFailed > 0 ? 1 : 0);
}

main();
