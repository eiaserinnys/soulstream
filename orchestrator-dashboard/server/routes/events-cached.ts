/**
 * events-cached 라우트 — DB 히스토리 재생 → soul-stream SSE 중계.
 *
 * 패턴:
 *   1. Last-Event-ID 헤더 파싱 → DB에서 after_id 이후 이벤트 스트리밍
 *   2. soul-stream /api/sessions/:id/events SSE 중계
 *      - upstream 청크를 '\n\n' 단위로 버퍼링하여 완전한 SSE 이벤트만 전달
 */

import { Router } from 'express';
import type { OrchestratorSessionDB } from '../db/session-db.js';

export function createEventsCachedRouter(
  db: OrchestratorSessionDB,
  soulStreamUrl: string
): Router {
  const router = Router();

  router.get('/sessions/:id/events', async (req, res) => {
    const { id } = req.params;
    const lastEventIdHeader = req.headers['last-event-id'];
    const afterId = lastEventIdHeader ? parseInt(lastEventIdHeader as string, 10) : 0;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // 1. DB 히스토리 재생
    let lastId = afterId;
    try {
      for await (const event of db.streamEvents(id, afterId)) {
        res.write(`id: ${event.id}\nevent: ${event.eventType}\ndata: ${event.data}\n\n`);
        lastId = event.id;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'db_error';
      res.write(`event: error\ndata: ${JSON.stringify({ message })}\n\n`);
      res.end();
      return;
    }

    // 2. soul-stream SSE 중계
    const upstreamUrl = `${soulStreamUrl}/api/sessions/${id}/events`;
    let upstreamRes: Response;
    try {
      upstreamRes = await fetch(upstreamUrl, {
        headers: { 'Last-Event-ID': String(lastId) },
      });
    } catch (_err) {
      res.write(`event: error\ndata: ${JSON.stringify({ message: 'upstream_connect_failed' })}\n\n`);
      res.end();
      return;
    }

    if (!upstreamRes.ok) {
      res.write(`event: error\ndata: ${JSON.stringify({ status: upstreamRes.status })}\n\n`);
      res.end();
      return;
    }
    if (!upstreamRes.body) {
      res.end();
      return;
    }

    req.on('close', () => void upstreamRes.body!.cancel());

    const reader = upstreamRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // '\n\n' 단위로 완전한 SSE 이벤트만 전달 (청크 경계 깨짐 방지)
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';
        for (const part of parts) {
          if (part.trim()) res.write(part + '\n\n');
        }
      }
      // 남은 버퍼 처리
      if (buffer.trim()) res.write(buffer + '\n\n');
    } finally {
      res.end();
    }
  });

  return router;
}
