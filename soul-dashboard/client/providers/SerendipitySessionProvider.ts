/**
 * SerendipitySessionProvider - 세렌디피티 API 기반 세션 Provider
 *
 * 세렌디피티에 저장된 Soul 세션 페이지를 대시보드에서 조회합니다.
 * Soul Plugin이 생성한 soul:* 블록 타입을 EventTreeNode로 변환합니다.
 */

import type {
  SessionStorageProvider,
  StorageMode,
  SessionListResult,
  SerendipityBlock,
  SoulBlockType,
  PortableTextContent,
} from "./types";
import type {
  SessionSummary,
  EventTreeNode,
  SoulSSEEvent,
  SessionStatus,
} from "@shared/types";

/**
 * 세렌디피티 페이지 응답 타입.
 */
interface SerendipityPage {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  blocks: SerendipityBlock[];
}

/**
 * 세렌디피티 페이지 목록 응답 타입.
 */
interface SerendipityPageSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * 세렌디피티 라벨 타입.
 */
interface SerendipityLabel {
  id: string;
  name: string;
}

/**
 * SerendipitySessionProvider 옵션.
 */
export interface SerendipitySessionProviderOptions {
  /** 세렌디피티 API 기본 URL. 기본값: /serendipity-api */
  baseUrl?: string;
  /** Soul 세션 라벨 이름. 이 라벨이 있는 페이지만 세션으로 간주 */
  sessionLabelName?: string;
  /** 폴링 간격 (ms). 기본 10000 */
  pollingIntervalMs?: number;
}

const DEFAULT_OPTIONS: Required<SerendipitySessionProviderOptions> = {
  baseUrl: "/serendipity-api",
  sessionLabelName: "soul-session",
  pollingIntervalMs: 10000,
};

/**
 * 세렌디피티 API 기반 세션 Provider.
 *
 * Soul Plugin이 세렌디피티에 저장한 세션 페이지를 조회하여
 * 대시보드에서 표시합니다.
 */
export class SerendipitySessionProvider implements SessionStorageProvider {
  readonly mode: StorageMode = "serendipity";

  private readonly options: Required<SerendipitySessionProviderOptions>;

  constructor(options: SerendipitySessionProviderOptions = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * 세션 목록 조회 (전체 목록 반환).
   *
   * soul-session 라벨이 있는 세렌디피티 페이지 목록을 반환합니다.
   * 가상 스크롤이 클라이언트 측에서 렌더링을 제어합니다.
   */
  async fetchSessions(_sessionType?: string): Promise<SessionListResult> {
    const { baseUrl, sessionLabelName } = this.options;

    try {
      // 1. 모든 페이지 목록 조회 (TODO: 라벨 필터링 API가 있으면 활용)
      const pagesRes = await fetch(`${baseUrl}/pages`);
      if (!pagesRes.ok) {
        throw new Error(`Serendipity API error: ${pagesRes.status}`);
      }

      const pages: SerendipityPageSummary[] = await pagesRes.json();

      // 2. 각 페이지의 라벨을 확인하여 soul-session 라벨이 있는지 검사
      const sessions: SessionSummary[] = [];

      for (const page of pages) {
        try {
          const labelsRes = await fetch(`${baseUrl}/pages/${page.id}/labels`);
          if (!labelsRes.ok) continue;

          const labels: SerendipityLabel[] = await labelsRes.json();
          const hasSoulLabel = labels.some((l) => l.name === sessionLabelName);

          if (hasSoulLabel) {
            sessions.push(this.pageToSessionSummary(page));
          }
        } catch {
          // 개별 페이지 오류는 무시
          continue;
        }
      }

      // 최신 순 정렬
      sessions.sort((a, b) => {
        const aTime = a.createdAt ?? "";
        const bTime = b.createdAt ?? "";
        return bTime.localeCompare(aTime);
      });

      return { sessions, total: sessions.length };
    } catch (err) {
      console.error("[SerendipitySessionProvider] fetchSessions error:", err);
      throw err;
    }
  }

  /**
   * 세션 카드 목록 조회.
   *
   * 세렌디피티 페이지의 블록을 EventTreeNode로 변환합니다.
   *
   * @param sessionKey - 세션 키 (세렌디피티 페이지 UUID)
   */
  async fetchCards(sessionKey: string): Promise<EventTreeNode[]> {
    const { baseUrl } = this.options;

    const pageRes = await fetch(`${baseUrl}/pages/${sessionKey}`);
    if (!pageRes.ok) {
      throw new Error(`Serendipity API error: ${pageRes.status}`);
    }

    const page: SerendipityPage = await pageRes.json();
    return this.blocksToCards(page.blocks);
  }

  /**
   * 실시간 업데이트 구독.
   *
   * 세렌디피티 모드에서는 폴링으로 변경 사항을 감지합니다.
   * (향후 Yjs WebSocket 연동 가능)
   *
   * @param sessionKey - 세션 키 (세렌디피티 페이지 UUID)
   * @param onEvent - 이벤트 수신 콜백
   * @returns 구독 해제 함수
   */
  subscribe(
    sessionKey: string,
    onEvent: (event: SoulSSEEvent, eventId: number) => void,
    _onStatusChange?: (status: "connecting" | "connected" | "error") => void,
  ): () => void {
    const { pollingIntervalMs } = this.options;

    let lastBlockCount = 0;
    let eventIdCounter = 0;

    const poll = async () => {
      try {
        const cards = await this.fetchCards(sessionKey);

        // 새 블록이 추가된 경우 이벤트 발생
        if (cards.length > lastBlockCount) {
          const newCards = cards.slice(lastBlockCount);

          for (const card of newCards) {
            // Node를 SSE 이벤트로 변환하여 전달
            const event = this.nodeToEvent(card);
            if (event) {
              eventIdCounter += 1;
              onEvent(event, eventIdCounter);
            }
          }

          lastBlockCount = cards.length;
        }
      } catch {
        // 폴링 오류는 무시하고 다음 주기에 재시도
      }
    };

    // 초기 폴링
    poll();

    // 주기적 폴링
    const timer = setInterval(poll, pollingIntervalMs);

    return () => {
      clearInterval(timer);
    };
  }

  // === Private Helpers ===

  /**
   * 세렌디피티 페이지를 SessionSummary로 변환.
   */
  private pageToSessionSummary(page: SerendipityPageSummary): SessionSummary {
    // 페이지 UUID를 agentSessionId로 사용
    return {
      agentSessionId: page.id,
      status: "completed" as SessionStatus, // 세렌디피티에 저장된 세션은 완료된 것으로 간주
      eventCount: 0, // 블록 수는 상세 조회 시 확인
      createdAt: page.createdAt,
      completedAt: page.updatedAt,
    };
  }

  /**
   * 세렌디피티 블록 배열을 EventTreeNode 배열로 변환.
   */
  private blocksToCards(blocks: SerendipityBlock[]): EventTreeNode[] {
    const nodes: EventTreeNode[] = [];

    for (const block of blocks) {
      const node = this.blockToNode(block);
      if (node) {
        nodes.push(node);
      }
    }

    return nodes;
  }

  /**
   * 단일 세렌디피티 블록을 EventTreeNode로 변환.
   */
  private blockToNode(block: SerendipityBlock): EventTreeNode | null {
    const blockType = block.type as SoulBlockType;
    const content = this.extractTextFromPortableText(block.content);

    switch (blockType) {
      case "soul:user":
      case "soul:assistant":
      case "soul:thinking":
      case "soul:intervention":
        return {
          id: block.id,
          type: "text",
          children: [],
          content,
          completed: true,
        };

      case "soul:tool_use": {
        // tool_use 블록의 메타데이터에서 도구 정보 추출
        const toolUseData = this.extractToolData(block.content);
        return {
          id: block.id,
          type: "tool",
          children: [],
          content: "",
          toolName: toolUseData.toolName,
          toolInput: toolUseData.toolInput,
          completed: false, // tool_result가 올 때까지 미완료
        };
      }

      case "soul:tool_result": {
        // tool_result는 이전 tool_use 노드를 업데이트하는 용도
        // 여기서는 별도 노드로 생성하고, 레이아웃에서 매칭
        const toolResultData = this.extractToolResultData(block.content);
        return {
          id: block.id,
          type: "tool",
          children: [],
          content: "",
          toolName: toolResultData.toolName,
          toolInput: {},
          toolResult: toolResultData.result,
          isError: toolResultData.isError,
          completed: true,
        };
      }

      case "soul:error":
        return {
          id: block.id,
          type: "text",
          children: [],
          content: `Error: ${content}`,
          completed: true,
        };

      case "paragraph":
      default:
        // 일반 텍스트 블록
        if (content.trim()) {
          return {
            id: block.id,
            type: "text",
            children: [],
            content,
            completed: true,
          };
        }
        return null;
    }
  }

  /**
   * Portable Text에서 일반 텍스트 추출.
   */
  private extractTextFromPortableText(content: PortableTextContent): string {
    if (!content?.content) return "";

    return content.content
      .map((block) =>
        block.children?.map((span) => span.text).join("") ?? ""
      )
      .join("\n");
  }

  /**
   * tool_use 블록에서 도구 데이터 추출.
   *
   * Portable Text의 첫 번째 블록에 JSON으로 인코딩된 도구 정보가 있다고 가정.
   */
  private extractToolData(content: PortableTextContent): {
    toolName: string;
    toolInput: Record<string, unknown>;
  } {
    const text = this.extractTextFromPortableText(content);

    try {
      const data = JSON.parse(text);
      return {
        toolName: data.name || "unknown",
        toolInput: data.input || {},
      };
    } catch {
      return {
        toolName: "unknown",
        toolInput: {},
      };
    }
  }

  /**
   * tool_result 블록에서 결과 데이터 추출.
   */
  private extractToolResultData(content: PortableTextContent): {
    toolName: string;
    result: string;
    isError: boolean;
  } {
    const text = this.extractTextFromPortableText(content);

    try {
      const data = JSON.parse(text);
      return {
        toolName: data.name || "unknown",
        result: data.result || text,
        isError: data.is_error ?? false,
      };
    } catch {
      return {
        toolName: "unknown",
        result: text,
        isError: false,
      };
    }
  }

  /**
   * EventTreeNode를 SoulSSEEvent로 변환 (폴링 업데이트용).
   */
  private nodeToEvent(node: EventTreeNode): SoulSSEEvent | null {
    if (node.type === "text") {
      return {
        type: "text_end",
        timestamp: 0,
      };
    }

    if (node.type === "tool" && node.completed) {
      return {
        type: "tool_result",
        timestamp: 0,
        tool_name: node.toolName,
        result: node.toolResult ?? "",
        is_error: node.isError ?? false,
      };
    }

    if (node.type === "tool" && !node.completed) {
      return {
        type: "tool_start",
        timestamp: 0,
        tool_name: node.toolName,
        tool_input: node.toolInput,
      };
    }

    return null;
  }
}

/** SerendipitySessionProvider 싱글톤 인스턴스 */
export const serendipitySessionProvider = new SerendipitySessionProvider();
