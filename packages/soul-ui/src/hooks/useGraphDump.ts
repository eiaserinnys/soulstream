/**
 * useGraphDump — NodeGraph 상태 덤프 생성/다운로드
 *
 * 책임:
 *  - Ctrl+Shift+D 단축키로 현재 그래프 상태를 JSON 파일로 다운로드
 *  - 패널 버튼에서 호출할 dumpGraph 콜백 제공
 */

import { useCallback, useEffect } from "react";

import {
  createGraphDump,
  downloadDump,
} from "../lib/graph-dump";
import {
  type GraphNode,
  type GraphEdge,
} from "../lib/layout-engine";
import type { ProcessingContext } from "../stores/processing-context";
import type { EventTreeNode } from "@shared/types";

export interface UseGraphDumpParams {
  activeSessionKey: string | null;
  treeVersion: number;
  lastEventId: number;
  tree: EventTreeNode | null;
  nodes: GraphNode[];
  edges: GraphEdge[];
  processingCtx: ProcessingContext;
}

export interface UseGraphDumpResult {
  /** 패널 버튼/단축키 모두에서 호출 가능한 덤프 다운로드 함수 */
  dumpGraph: () => void;
}

export function useGraphDump({
  activeSessionKey,
  treeVersion,
  lastEventId,
  tree,
  nodes,
  edges,
  processingCtx,
}: UseGraphDumpParams): UseGraphDumpResult {
  const dumpGraph = useCallback(() => {
    const dump = createGraphDump(
      activeSessionKey,
      treeVersion,
      lastEventId,
      tree,
      nodes,
      edges,
      processingCtx,
    );
    downloadDump(dump);
  }, [activeSessionKey, treeVersion, lastEventId, tree, nodes, edges, processingCtx]);

  // Ctrl+Shift+D → 그래프 상태 덤프 다운로드
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key === "D") {
        e.preventDefault();
        dumpGraph();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [dumpGraph]);

  return { dumpGraph };
}
