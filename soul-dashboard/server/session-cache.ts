/**
 * Session Cache - 세션별 이벤트 로컬 캐시
 *
 * 대시보드 서버가 Soul 서버에서 수신한 이벤트를 로컬에 캐시합니다.
 * 서버 재시작 시에도 캐시된 이벤트를 클라이언트에 즉시 전송할 수 있습니다.
 *
 * 파일 경로: {cacheDir}/{agentSessionId}.jsonl
 * 각 줄: {"id": <monotonic_int>, "event": <event_dict>}
 */

import { appendFile, readFile, mkdir, rm } from "fs/promises";
import { join, dirname } from "path";

export interface SessionCacheOptions {
  /** 캐시 파일 기본 디렉토리 */
  cacheDir: string;
}

export interface CachedEvent {
  id: number;
  event: Record<string, unknown>;
}

/**
 * 세션별 이벤트 JSONL 캐시.
 *
 * Soul 서버에서 수신한 이벤트를 로컬에 캐시하여
 * 서버 재시작 시에도 빠르게 클라이언트에 전송할 수 있습니다.
 */
export class SessionCache {
  private readonly cacheDir: string;

  constructor(options: SessionCacheOptions) {
    this.cacheDir = options.cacheDir;
  }

  /**
   * 이벤트를 세션 캐시에 추가합니다.
   *
   * @param agentSessionId - 세션 식별자
   * @param eventId - 이벤트 ID (단조증가)
   * @param event - 이벤트 데이터
   */
  async appendEvent(
    agentSessionId: string,
    eventId: number,
    event: Record<string, unknown>,
  ): Promise<void> {
    const filePath = this.sessionPath(agentSessionId);

    // 디렉토리 생성 (없으면)
    await mkdir(dirname(filePath), { recursive: true });

    // JSONL 형식으로 추가
    const record: CachedEvent = { id: eventId, event };
    const line = JSON.stringify(record) + "\n";

    await appendFile(filePath, line, "utf-8");
  }

  /**
   * 세션의 캐시된 이벤트를 읽습니다.
   *
   * @param agentSessionId - 세션 식별자
   * @param afterId - 이 ID 이후의 이벤트만 반환 (옵션)
   * @returns 이벤트 배열
   */
  async readEvents(
    agentSessionId: string,
    afterId?: number,
  ): Promise<CachedEvent[]> {
    const filePath = this.sessionPath(agentSessionId);

    let content: string;
    try {
      content = await readFile(filePath, "utf-8");
    } catch {
      // 파일이 없으면 빈 배열
      return [];
    }

    const events = this.parseJsonl(content);

    if (afterId !== undefined) {
      return events.filter((ev) => ev.id > afterId);
    }

    return events;
  }

  /**
   * 세션의 마지막 이벤트 ID를 반환합니다.
   *
   * @param agentSessionId - 세션 식별자
   * @returns 마지막 이벤트 ID (없으면 0)
   */
  async getLastEventId(agentSessionId: string): Promise<number> {
    const events = await this.readEvents(agentSessionId);

    if (events.length === 0) {
      return 0;
    }

    return events[events.length - 1].id;
  }

  /**
   * 세션 캐시를 삭제합니다.
   *
   * @param agentSessionId - 세션 식별자
   */
  async deleteSession(agentSessionId: string): Promise<void> {
    const filePath = this.sessionPath(agentSessionId);

    try {
      await rm(filePath, { force: true });
    } catch {
      // 파일이 없어도 오류 없이 처리
    }
  }

  /**
   * 세션 캐시 파일 경로를 반환합니다.
   */
  sessionPath(agentSessionId: string): string {
    const safeId = this.sanitize(agentSessionId);
    return join(this.cacheDir, `${safeId}.jsonl`);
  }

  /**
   * 경로 탈출 방지를 위한 문자열 sanitize.
   */
  private sanitize(value: string): string {
    return value.replace(/[^\w.\-]/g, "_");
  }

  /**
   * JSONL 문자열을 파싱합니다.
   */
  private parseJsonl(content: string): CachedEvent[] {
    const records: CachedEvent[] = [];
    const lines = content.split("\n");

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const record = JSON.parse(trimmed) as CachedEvent;
        if (typeof record.id === "number" && record.event) {
          records.push(record);
        }
      } catch {
        console.warn("[SessionCache] Skipping corrupted JSONL line");
      }
    }

    return records;
  }
}
