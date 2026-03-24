/**
 * SessionDB — PostgreSQL 직접 쿼리 클래스.
 *
 * soul-server가 기록한 sessions, events, folders 테이블을 조회한다.
 */

import { randomUUID } from 'crypto'
import type { Pool } from 'pg'
import type { SessionSummary, Folder } from '../sessions/types'

export interface SessionRow extends SessionSummary {
  node_id: string
}

export interface EventRow {
  id: number
  eventType: string
  eventData: object
}

export class SessionDB {
  constructor(private pool: Pool) {}

  /**
   * after_id 초과 이벤트를 순서대로 yield한다. (SSE 엔드포인트용)
   * one-shot SELECT. LISTEN/NOTIFY 없음.
   */
  async *streamEvents(
    sessionId: string,
    afterId: number
  ): AsyncGenerator<EventRow> {
    const { rows } = await this.pool.query<{
      id: number
      event_type: string
      payload_text: string
    }>(
      `SELECT id, event_type, payload_text
       FROM events
       WHERE agent_session_id = $1 AND id > $2
       ORDER BY id ASC`,
      [sessionId, afterId]
    )
    for (const row of rows) {
      yield {
        id: row.id,
        eventType: row.event_type,
        eventData: JSON.parse(row.payload_text) as object,
      }
    }
  }

  /**
   * 세션의 모든 이벤트를 배열로 반환한다. (/cards 엔드포인트용)
   */
  async listEvents(sessionId: string): Promise<EventRow[]> {
    const { rows } = await this.pool.query<{
      id: number
      event_type: string
      payload_text: string
    }>(
      `SELECT id, event_type, payload_text
       FROM events
       WHERE agent_session_id = $1
       ORDER BY id ASC`,
      [sessionId]
    )
    return rows.map((row) => ({
      id: row.id,
      eventType: row.event_type,
      eventData: JSON.parse(row.payload_text) as object,
    }))
  }

  /**
   * 세션 목록 조회. folderId 필터 + cursor 페이지네이션 지원.
   */
  async listSessions(options?: {
    folderId?: string
    limit?: number
    cursor?: number
  }): Promise<{ sessions: SessionSummary[]; total: number; nextCursor?: number }> {
    const limit = options?.limit ?? 50
    const cursor = options?.cursor ?? 0
    const folderId = options?.folderId

    const params: unknown[] = [limit + 1, cursor]
    let whereClause = 'WHERE id > $2'
    if (folderId !== undefined) {
      params.push(folderId)
      whereClause += ` AND folder_id = $${params.length}`
    }

    const { rows } = await this.pool.query<{
      id: number
      agent_session_id: string
      status: string
      created_at: string
      updated_at: string | null
      last_message: unknown
      prompt: string | null
      folder_id: string | null
      node_id: string
    }>(
      `SELECT id, agent_session_id, status, created_at, updated_at, last_message, prompt, folder_id, node_id
       FROM sessions
       ${whereClause}
       ORDER BY id DESC
       LIMIT $1`,
      params
    )

    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows

    const { rows: countRows } = await this.pool.query<{ count: string }>(
      folderId !== undefined
        ? `SELECT COUNT(*) as count FROM sessions WHERE folder_id = $1`
        : `SELECT COUNT(*) as count FROM sessions`,
      folderId !== undefined ? [folderId] : []
    )
    const total = parseInt(countRows[0]?.count ?? '0', 10)

    const sessions: SessionSummary[] = page.map((row) => ({
      sessionId: row.agent_session_id,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at ?? undefined,
      lastMessage: row.last_message,
      prompt: row.prompt ?? undefined,
      folderId: row.folder_id ?? null,
    }))

    const result: { sessions: SessionSummary[]; total: number; nextCursor?: number } = {
      sessions,
      total,
    }
    if (hasMore) {
      result.nextCursor = rows[limit - 1]!.id
    }
    return result
  }

  /**
   * 폴더 목록 전체 반환.
   */
  async listFolders(): Promise<Folder[]> {
    const { rows } = await this.pool.query<{
      id: string
      name: string
      parent_id: string | null
      created_at: string
    }>(
      `SELECT id, name, parent_id, created_at FROM folders ORDER BY name ASC`
    )
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      parentId: row.parent_id,
      createdAt: row.created_at,
    }))
  }

  /**
   * 폴더 생성. UUID는 Node.js crypto로 생성.
   */
  async createFolder(name: string): Promise<Folder> {
    const id = randomUUID()
    const { rows } = await this.pool.query<{
      id: string
      name: string
      parent_id: string | null
      created_at: string
    }>(
      `INSERT INTO folders (id, name) VALUES ($1, $2) RETURNING id, name, parent_id, created_at`,
      [id, name]
    )
    const row = rows[0]!
    return {
      id: row.id,
      name: row.name,
      parentId: row.parent_id,
      createdAt: row.created_at,
    }
  }

  /**
   * 폴더 이름 변경. 없으면 null 반환.
   */
  async updateFolder(id: string, name: string): Promise<Folder | null> {
    const { rows } = await this.pool.query<{
      id: string
      name: string
      parent_id: string | null
      created_at: string
    }>(
      `UPDATE folders SET name = $2 WHERE id = $1 RETURNING id, name, parent_id, created_at`,
      [id, name]
    )
    if (rows.length === 0) return null
    const row = rows[0]!
    return {
      id: row.id,
      name: row.name,
      parentId: row.parent_id,
      createdAt: row.created_at,
    }
  }

  /**
   * 폴더 삭제. 해당 폴더의 세션 folder_id를 NULL로 초기화 후 삭제.
   */
  async deleteFolder(id: string): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`UPDATE sessions SET folder_id = NULL WHERE folder_id = $1`, [id])
      await client.query(`DELETE FROM folders WHERE id = $1`, [id])
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  /**
   * 세션 목록을 특정 폴더로 이동. folderId = null이면 폴더 배정 해제.
   */
  async moveSessionsToFolder(
    sessionIds: string[],
    folderId: string | null
  ): Promise<void> {
    if (sessionIds.length === 0) return
    await this.pool.query(
      `UPDATE sessions SET folder_id = $1 WHERE agent_session_id = ANY($2::text[])`,
      [folderId, sessionIds]
    )
  }

  /**
   * 세션 단건 조회. node_id 포함. 없으면 null.
   */
  async getSession(sessionId: string): Promise<SessionRow | null> {
    const { rows } = await this.pool.query<{
      agent_session_id: string
      status: string
      created_at: string
      updated_at: string | null
      last_message: unknown
      prompt: string | null
      folder_id: string | null
      node_id: string
    }>(
      `SELECT agent_session_id, status, created_at, updated_at, last_message, prompt, folder_id, node_id
       FROM sessions
       WHERE agent_session_id = $1`,
      [sessionId]
    )
    if (rows.length === 0) return null
    const row = rows[0]!
    return {
      sessionId: row.agent_session_id,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at ?? undefined,
      lastMessage: row.last_message,
      prompt: row.prompt ?? undefined,
      folderId: row.folder_id ?? null,
      node_id: row.node_id,
    }
  }
}
