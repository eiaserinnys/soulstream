/**
 * Session Store - JSONL 파일 읽기 전용 저장소
 *
 * Soul 서버의 EventStore(Python)가 생성한 JSONL 파일을 읽어
 * 세션 목록과 이벤트 내역을 제공합니다.
 *
 * 파일 경로 규칙: {baseDir}/{agentSessionId}.jsonl (플랫 구조)
 * 각 줄: {"id": <monotonic_int>, "event": <event_dict>}
 *
 * Soul 서버가 JSONL의 유일한 기록자. 대시보드는 읽기 전용.
 */

import { readFile, readdir, stat } from "fs/promises";
import { join, basename } from "path";
import type {
  EventRecord,
  SessionSummary,
  SessionStatus,
} from "../shared/types.js";

export interface SessionStoreOptions {
  /** JSONL 파일 기본 디렉토리 */
  baseDir: string;
}

/**
 * JSONL 파일 읽기 전용 세션 저장소.
 *
 * EventStore(Python)가 작성한 JSONL 파일을 읽어
 * 대시보드 API에 세션/이벤트 데이터를 제공합니다.
 */
export class SessionStore {
  private readonly baseDir: string;

  constructor(options: SessionStoreOptions) {
    this.baseDir = options.baseDir;
  }

  /**
   * 모든 세션의 요약 목록을 반환합니다.
   *
   * baseDir 직하의 *.jsonl 파일을 스캔합니다 (플랫 구조).
   * 파일명 = agentSessionId.
   */
  async listSessions(): Promise<SessionSummary[]> {
    const sessions: SessionSummary[] = [];

    let files: string[];
    try {
      files = await readdir(this.baseDir);
    } catch {
      // baseDir이 없으면 빈 목록 반환
      return sessions;
    }

    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;

      const agentSessionId = basename(file, ".jsonl");

      // 파일명 안전성 검증
      if (!this.isValidPathComponent(agentSessionId)) {
        console.warn(
          `[SessionStore] Skipping invalid session file: ${file}`,
        );
        continue;
      }

      const filePath = join(this.baseDir, file);

      // 디렉토리가 아닌 파일만 처리
      let fileStat;
      try {
        fileStat = await stat(filePath);
      } catch {
        continue;
      }
      if (!fileStat.isFile()) continue;

      try {
        const summary = await this.readSessionSummary(
          agentSessionId,
          filePath,
        );
        sessions.push(summary);
      } catch (err) {
        console.warn(
          `[SessionStore] Failed to read session ${agentSessionId}:`,
          err,
        );
      }
    }

    // 최신 세션이 먼저 오도록 정렬
    sessions.sort((a, b) => {
      const aTime = a.createdAt ?? "";
      const bTime = b.createdAt ?? "";
      return bTime.localeCompare(aTime);
    });

    return sessions;
  }

  /**
   * 특정 세션의 모든 이벤트를 반환합니다.
   *
   * @param agentSessionId - 세션 식별자
   * @returns 이벤트 레코드 배열 (id 오름차순)
   */
  async readEvents(agentSessionId: string): Promise<EventRecord[]> {
    const filePath = this.sessionPath(agentSessionId);

    let content: string;
    try {
      content = await readFile(filePath, "utf-8");
    } catch {
      return [];
    }

    return this.parseJsonl(content);
  }

  /**
   * 특정 ID 이후의 이벤트만 반환합니다 (Last-Event-ID 재연결용).
   *
   * @param agentSessionId - 세션 식별자
   * @param afterId - 이 ID 이후의 이벤트만 반환
   */
  async readEventsSince(
    agentSessionId: string,
    afterId: number,
  ): Promise<EventRecord[]> {
    const events = await this.readEvents(agentSessionId);
    return events.filter((ev) => ev.id > afterId);
  }

  /**
   * 세션의 마지막 이벤트 타입으로 상태를 추론합니다.
   */
  inferStatus(lastEventType?: string): SessionStatus {
    if (!lastEventType) return "unknown";
    if (lastEventType === "complete" || lastEventType === "result")
      return "completed";
    if (lastEventType === "error") return "error";
    return "running";
  }

  sessionPath(agentSessionId: string): string {
    // 경로 탈출 방지: 안전한 문자만 허용
    const safeId = this.sanitize(agentSessionId);
    return join(this.baseDir, `${safeId}.jsonl`);
  }

  private sanitize(value: string): string {
    return value.replace(/[^\w.\-]/g, "_");
  }

  private isValidPathComponent(value: string): boolean {
    return /^[\w.\-]+$/.test(value);
  }

  private parseJsonl(content: string): EventRecord[] {
    const records: EventRecord[] = [];
    const lines = content.split("\n");

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const record = JSON.parse(trimmed) as EventRecord;
        if (typeof record.id === "number" && record.event) {
          records.push(record);
        }
      } catch {
        console.warn("[SessionStore] Skipping corrupted JSONL line");
      }
    }

    return records;
  }

  private async readSessionSummary(
    agentSessionId: string,
    filePath: string,
  ): Promise<SessionSummary> {
    const content = await readFile(filePath, "utf-8");
    const records = this.parseJsonl(content);

    const eventCount = records.length;
    const lastRecord = records[records.length - 1];
    const lastEventType = lastRecord?.event?.type as string | undefined;
    const firstRecord = records[0];

    // 첫 이벤트의 타임스탬프에서 생성 시간 추정
    let createdAt: string | undefined;
    if (firstRecord?.event) {
      const eventData = firstRecord.event as Record<string, unknown>;
      if (typeof eventData.created_at === "string") {
        createdAt = eventData.created_at;
      }
    }

    // 파일 수정 시간을 폴백으로 사용
    if (!createdAt) {
      try {
        const fileStat = await stat(filePath);
        createdAt = fileStat.birthtime.toISOString();
      } catch {
        // ignore
      }
    }

    // 완료 시간: complete/error 이벤트의 타임스탬프
    let completedAt: string | undefined;
    if (
      lastEventType === "complete" ||
      lastEventType === "error" ||
      lastEventType === "result"
    ) {
      try {
        const fileStat = await stat(filePath);
        completedAt = fileStat.mtime.toISOString();
      } catch {
        // ignore
      }
    }

    // 첫 user_message에서 프롬프트 추출
    let prompt: string | undefined;
    for (const record of records) {
      const evt = record.event as Record<string, unknown>;
      if (evt.type === "user_message" && typeof evt.text === "string") {
        prompt = evt.text;
        break;
      }
    }

    return {
      agentSessionId,
      status: this.inferStatus(lastEventType),
      eventCount,
      lastEventType,
      createdAt,
      completedAt,
      prompt,
    };
  }
}
