/**
 * SerendipitySessionProvider - 세렌디피티 API 기반 세션 Provider
 *
 * 세렌디피티에 저장된 Soul 세션 페이지를 대시보드에서 조회합니다.
 * Soul Plugin이 생성한 soul:* 블록 타입을 DashboardCard로 변환합니다.
 */

import type {
  SessionStorageProvider,
  StorageMode,
  SerendipityBlock,
  SoulBlockType,
  PortableTextContent,
} from "./types";
import type {
  SessionSummary,
  DashboardCard,
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
   * 세션 목록 조회.
   *
   * soul-session 라벨이 있는 세렌디피티 페이지 목록을 반환합니다.
   */
  async fetchSessions(): Promise<SessionSummary[]> {
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

      return sessions;
    } catch (err) {
      console.error("[SerendipitySessionProvider] fetchSessions error:", err);
      throw err;
    }
  }

  /**
   * 세션 카드 목록 조회.
   *
   * 세렌디피티 페이지의 블록을 DashboardCard로 변환합니다.
   *
   * @param sessionKey - 세션 키 (세렌디피티 페이지 UUID)
   */
  async fetchCards(sessionKey: string): Promise<DashboardCard[]> {
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
    onEvent: (event: SoulSSEEvent, eventId: number) => void
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
            // Card를 SSE 이벤트로 변환하여 전달
            const event = this.cardToEvent(card);
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
    // 페이지 제목에서 세션 정보 추출
    // 예: "Soul Session: 2026-03-01 12:34" 또는 "clientId:requestId"
    const titleParts = page.title.split(":");
    const clientId = titleParts[0] || "serendipity";
    const requestId = page.id; // 페이지 UUID를 requestId로 사용

    return {
      clientId,
      requestId,
      status: "completed" as SessionStatus, // 세렌디피티에 저장된 세션은 완료된 것으로 간주
      eventCount: 0, // 블록 수는 상세 조회 시 확인
      createdAt: page.createdAt,
      completedAt: page.updatedAt,
    };
  }

  /**
   * 세렌디피티 블록 배열을 DashboardCard 배열로 변환.
   */
  private blocksToCards(blocks: SerendipityBlock[]): DashboardCard[] {
    const cards: DashboardCard[] = [];

    for (const block of blocks) {
      const card = this.blockToCard(block);
      if (card) {
        cards.push(card);
      }
    }

    return cards;
  }

  /**
   * 단일 세렌디피티 블록을 DashboardCard로 변환.
   */
  private blockToCard(block: SerendipityBlock): DashboardCard | null {
    const blockType = block.type as SoulBlockType;
    const content = this.extractTextFromPortableText(block.content);

    switch (blockType) {
      case "soul:user":
      case "soul:assistant":
      case "soul:thinking":
        return {
          cardId: block.id,
          type: "text",
          content,
          completed: true,
        };

      case "soul:tool_use":
        // tool_use 블록의 메타데이터에서 도구 정보 추출
        const toolUseData = this.extractToolData(block.content);
        return {
          cardId: block.id,
          type: "tool",
          content: "",
          toolName: toolUseData.toolName,
          toolInput: toolUseData.toolInput,
          completed: false, // tool_result가 올 때까지 미완료
        };

      case "soul:tool_result":
        // tool_result는 이전 tool_use 카드를 업데이트하는 용도
        // 여기서는 별도 카드로 생성하고, 레이아웃에서 매칭
        const toolResultData = this.extractToolResultData(block.content);
        return {
          cardId: block.id,
          type: "tool",
          content: "",
          toolName: toolResultData.toolName,
          toolResult: toolResultData.result,
          isError: toolResultData.isError,
          completed: true,
        };

      case "soul:error":
        return {
          cardId: block.id,
          type: "text",
          content: `Error: ${content}`,
          completed: true,
        };

      case "paragraph":
      default:
        // 일반 텍스트 블록
        if (content.trim()) {
          return {
            cardId: block.id,
            type: "text",
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
   * DashboardCard를 SoulSSEEvent로 변환 (폴링 업데이트용).
   */
  private cardToEvent(card: DashboardCard): SoulSSEEvent | null {
    if (card.type === "text") {
      // text_end 이벤트로 전달 (이미 완료된 카드)
      return {
        type: "text_end",
        card_id: card.cardId,
      };
    }

    if (card.type === "tool" && card.completed) {
      // tool_result 이벤트로 전달
      return {
        type: "tool_result",
        card_id: card.cardId,
        tool_name: card.toolName ?? "unknown",
        result: card.toolResult ?? "",
        is_error: card.isError ?? false,
      };
    }

    if (card.type === "tool" && !card.completed) {
      // tool_start 이벤트로 전달
      return {
        type: "tool_start",
        card_id: card.cardId,
        tool_name: card.toolName ?? "unknown",
        tool_input: card.toolInput ?? {},
      };
    }

    return null;
  }
}

/** SerendipitySessionProvider 싱글톤 인스턴스 */
export const serendipitySessionProvider = new SerendipitySessionProvider();
