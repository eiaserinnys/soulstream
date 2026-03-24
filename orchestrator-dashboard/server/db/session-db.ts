/**
 * OrchestratorSessionDB — PostgreSQL 직접 쿼리 클래스.
 *
 * soul-stream의 session-db.ts와 동일한 스키마를 사용하나,
 * soul-stream 패키지가 private: true이므로 orchestrator BFF 전용으로 재구현.
 *
 * 스키마:
 *   events: id (PK), agent_session_id (FK), event_type, payload_text
 *   sessions: id, agent_session_id (PK), node_id, folder_id, status, created_at, updated_at
 *   folders: id, name, parent_id, created_at
 */

import pg from 'pg';

export class OrchestratorSessionDB {
  constructor(private pool: pg.Pool) {}

  /**
   * afterId 초과 이벤트를 순서대로 yield한다. (SSE 엔드포인트용)
   */
  async *streamEvents(
    sessionId: string,
    afterId: number
  ): AsyncGenerator<{ id: number; eventType: string; data: string }> {
    const result = await this.pool.query<{
      id: number;
      event_type: string;
      payload_text: string;
    }>(
      `SELECT id, event_type, payload_text
       FROM events
       WHERE agent_session_id = $1 AND id > $2
       ORDER BY id ASC`,
      [sessionId, afterId]
    );
    for (const row of result.rows) {
      yield {
        id: row.id,
        eventType: row.event_type,
        data: row.payload_text,
      };
    }
  }

  /**
   * 세션 단건 조회.
   */
  async getSession(sessionId: string): Promise<{
    session_id: string;
    node_id: string;
    status: string;
    created_at: string;
    updated_at: string | null;
  } | null> {
    const result = await this.pool.query<{
      session_id: string;
      node_id: string;
      status: string;
      created_at: string;
      updated_at: string | null;
    }>(
      `SELECT agent_session_id AS session_id, node_id, status, created_at, updated_at
       FROM sessions
       WHERE agent_session_id = $1`,
      [sessionId]
    );
    return result.rows[0] ?? null;
  }

  /**
   * 폴더 목록 전체 반환.
   */
  async listFolders(): Promise<{
    id: string;
    name: string;
    parent_id: string | null;
    created_at: string;
  }[]> {
    const result = await this.pool.query<{
      id: string;
      name: string;
      parent_id: string | null;
      created_at: string;
    }>(
      `SELECT id, name, parent_id, created_at FROM folders ORDER BY name ASC`
    );
    return result.rows;
  }

  /**
   * 세션 목록 조회. folderId 필터 + cursor(정수 id 기반) 페이지네이션 지원.
   */
  async listSessions(opts?: {
    folderId?: string;
    limit?: number;
    cursor?: number;
  }): Promise<{
    id: number;
    session_id: string;
    node_id: string;
    folder_id: string | null;
    status: string;
    created_at: string;
    updated_at: string | null;
  }[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (opts?.folderId !== undefined) {
      params.push(opts.folderId);
      conditions.push(`folder_id = $${params.length}`);
    }
    if (opts?.cursor != null) {
      params.push(opts.cursor);
      conditions.push(`id > $${params.length}`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = opts?.limit ?? 100;
    params.push(limit);

    const result = await this.pool.query<{
      id: number;
      session_id: string;
      node_id: string;
      folder_id: string | null;
      status: string;
      created_at: string;
      updated_at: string | null;
    }>(
      `SELECT id, agent_session_id AS session_id, node_id, folder_id, status, created_at, updated_at
       FROM sessions ${where}
       ORDER BY id DESC
       LIMIT $${params.length}`,
      params
    );
    return result.rows;
  }
}
