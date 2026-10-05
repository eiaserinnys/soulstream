import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { InMemorySseReplayBroadcaster, type SessionStreamEvent } from '../src/sse/replay_broadcaster.js';
import { registerSseReplayRoutes } from '../src/sse/sse_replay_routes.js';

function frames(body: string) {
  return body.trim().split('\n\n').filter((frame) => frame.startsWith('event:'))
    .map((frame) => ({
      type: frame.split('\n')[0]!.slice(7),
      id: frame.match(/\nid: (\d+)/)?.[1],
      data: JSON.parse(frame.split('\ndata: ')[1]!),
    }));
}

describe('catalog catchup opt-in on actual HTTP route', () => {
  it('sends the feed display page fields in its first snapshot frame', async () => {
    const broadcaster = new InMemorySseReplayBroadcaster<SessionStreamEvent>({ instanceId: 'catalog' });
    const loadSnapshot = vi.fn(async () => ({
      sessions: [{ agentSessionId: 'running-a' }],
      total: 411,
      hasMore: true,
      nextCursor: '30',
      folders: [{ id: 'folder-a', settings: {} }],
    }));
    const app = Fastify();
    registerSseReplayRoutes(app, {
      session: { broadcaster, loadSnapshot },
      replayOnlyForTests: true,
    });
    try {
      const response = await app.inject('/api/sessions/stream?feed_display=true&limit=30');
      const output = frames(response.body);
      expect(output.map(frame => frame.type)).toEqual(['stream_meta', 'session_list']);
      expect(output[1]!.data).toEqual({
        type: 'session_list',
        sessions: [{ agentSessionId: 'running-a' }],
        total: 411,
        hasMore: true,
        nextCursor: '30',
        folders: [{ id: 'folder-a', settings: {} }],
      });
      expect(loadSnapshot).toHaveBeenCalledOnce();
    } finally { await app.close(); }
  });

  it.each([30, 31])('replays %s feed display events or replaces an overflowing backlog with a snapshot', async (count) => {
    const broadcaster = new InMemorySseReplayBroadcaster<SessionStreamEvent>({ instanceId: 'catalog' });
    for (let n = 0; n < count; n++) broadcaster.append({ type: 'session_updated', n });
    const loadSnapshot = vi.fn(async () => ({
      sessions: [{ agentSessionId: 'snapshot' }],
      total: 411,
      hasMore: true,
      nextCursor: '30',
      folders: [],
    }));
    const app = Fastify();
    registerSseReplayRoutes(app, {
      session: { broadcaster, loadSnapshot },
      replayOnlyForTests: true,
    });
    try {
      const response = await app.inject(
        `/api/sessions/stream?feed_display=true&lastEventId=0&instanceId=catalog`,
      );
      const output = frames(response.body);
      if (count <= 30) {
        expect(output.filter(frame => frame.id)).toHaveLength(30);
        expect(output.map(frame => frame.type)).not.toContain('session_list');
        expect(loadSnapshot).not.toHaveBeenCalled();
      } else {
        expect(output.map(frame => frame.type)).toEqual(['stream_meta', 'session_list']);
        expect(output.some(frame => frame.type === 'replay_gap')).toBe(false);
        expect(loadSnapshot).toHaveBeenCalledOnce();
      }
    } finally { await app.close(); }
  });

  it.each(['ring_gap', 'instance_mismatch'])('replaces feed display %s cursors with a snapshot', async (gap) => {
    const broadcaster = new InMemorySseReplayBroadcaster<SessionStreamEvent>({
      instanceId: 'catalog',
      ringMaxlen: 1,
    });
    if (gap === 'ring_gap') {
      broadcaster.append({ type: 'session_updated', n: 1 });
      broadcaster.append({ type: 'session_updated', n: 2 });
    }
    const loadSnapshot = vi.fn(async () => ({ sessions: [], total: 411, hasMore: true, nextCursor: '30', folders: [] }));
    const app = Fastify();
    registerSseReplayRoutes(app, {
      session: { broadcaster, loadSnapshot },
      replayOnlyForTests: true,
    });
    try {
      const instanceId = gap === 'ring_gap' ? 'catalog' : 'old-instance';
      const response = await app.inject(
        `/api/sessions/stream?feed_display=true&lastEventId=0&instanceId=${instanceId}`,
      );
      const output = frames(response.body);
      expect(output.map(frame => frame.type)).toEqual(['stream_meta', 'session_list']);
      expect(output.some(frame => frame.type === 'replay_gap')).toBe(false);
      expect(loadSnapshot).toHaveBeenCalledOnce();
    } finally { await app.close(); }
  });

  it.each([200, 201, 1000])('raw backlog %s honors threshold before async scope filtering', async (count) => {
    const broadcaster = new InMemorySseReplayBroadcaster<SessionStreamEvent>({ instanceId: 'catalog' });
    for (let n = 0; n < count; n++) broadcaster.append({ type: 'session_updated', n });
    const filterEvent = vi.fn(async (_request, event) => event);
    const loadSnapshot = vi.fn(async () => ({ sessions: [] }));
    const app = Fastify();
    registerSseReplayRoutes(app, { session: { broadcaster, filterEvent, loadSnapshot }, replayOnlyForTests: true });
    try {
      const response = await app.inject('/api/sessions/stream?lastEventId=0&instanceId=catalog&snapshotCatchup=1');
      const output = frames(response.body);
      if (count > 200) {
        expect(output).toHaveLength(2);
        expect(output[1]).toEqual({ type: 'replay_gap', id: undefined, data: {
          type: 'replay_gap', latest_id: count, instance_id: 'catalog', reason: 'catchup_overflow',
        } });
        expect(filterEvent).not.toHaveBeenCalled();
      } else {
        expect(output.filter(f => f.id)).toHaveLength(count);
        expect(filterEvent).toHaveBeenCalledTimes(count);
      }
      expect(loadSnapshot).not.toHaveBeenCalled();
      // Capability-free consumers retain the existing durable replay contract.
      const legacy = await app.inject('/api/sessions/stream?lastEventId=0&instanceId=catalog');
      expect(frames(legacy.body).filter(f => f.id)).toHaveLength(count);
    } finally { await app.close(); }
  });

  it('serializes queued initial live and new live through asynchronous filters', async () => {
    const broadcaster = new InMemorySseReplayBroadcaster<SessionStreamEvent>({ instanceId: 'catalog' });
    let releaseSnapshot!: () => void;
    const snapshotWait = new Promise<void>(resolve => { releaseSnapshot = resolve; });
    let filterStarted!: () => void;
    const started = new Promise<void>(resolve => { filterStarted = resolve; });
    let releaseFilter!: () => void;
    const filterWait = new Promise<void>(resolve => { releaseFilter = resolve; });
    const app = Fastify();
    registerSseReplayRoutes(app, {
      session: {
        broadcaster,
        loadSnapshot: async () => {
          broadcaster.append({ type: 'session_updated', n: 1 });
          await snapshotWait;
          return { sessions: [] };
        },
        filterEvent: async (_request, event) => {
          if (event.n === 1) { filterStarted(); await filterWait; }
          return event;
        },
      },
    });
    const url = await app.listen({ port: 0, host: '127.0.0.1' });
    const controller = new AbortController();
    const responsePromise = fetch(url + '/api/sessions/stream', { signal: controller.signal });
    releaseSnapshot();
    await started;
    broadcaster.append({ type: 'session_updated', n: 2 });
    releaseFilter();
    try {
      const reader = (await responsePromise).body!.getReader();
      let body = '';
      while (frames(body).filter(f => f.id).length < 2) {
        const part = await reader.read();
        body += new TextDecoder().decode(part.value);
      }
      expect(frames(body).filter(f => f.id).map(f => f.data.n)).toEqual([1, 2]);
      await reader.cancel();
    } finally { controller.abort(); await app.close(); }
  });
});
