import {
  LIVE_TEXT_SNAPSHOT_MAX_UTF8_BYTES,
  liveTextEventMetadata,
  normalizeLiveTextSnapshot,
  resetRequiredStreamIdentities,
  snapshotStreamingEvents,
} from '../live-text-recovery';
import type { LiveTextSnapshotWire } from '../../api/types';

const exactSnapshot: LiveTextSnapshotWire = {
  type: 'text_snapshot',
  basedOnEventId: 1003,
  throughLiveSeq: 41,
  streams: [{
    streamIdentity: 'codex_app_server:dGhyZWFkLTE:dHVybi0y:aXRlbS0z',
    text: 'prefix already captured',
    updatedAt: '2026-08-06T00:00:05.000Z',
    truncated: false,
    resetRequired: false,
    recovery: 'none',
  }],
};

describe('server 7caf0414 live text recovery wire (contract 0ff47de3)', () => {
  test('exact snapshot을 transient assistant stream으로 만들고 boundary metadata를 보존한다', () => {
    const snapshot = normalizeLiveTextSnapshot(exactSnapshot);
    expect(snapshot).toEqual(exactSnapshot);
    expect(snapshotStreamingEvents(snapshot)).toEqual([{
      id: `live:text_snapshot:${exactSnapshot.streams[0].streamIdentity}`,
      type: 'text_delta',
      data: expect.objectContaining({
        text: 'prefix already captured',
        streamIdentity: exactSnapshot.streams[0].streamIdentity,
        liveSeq: 41,
        liveTextMode: 'replace',
        _recovered_snapshot: true,
      }),
    }]);
  });

  test('queued/live event의 identity·sequence·replace/append를 exact shape로만 받는다', () => {
    expect(liveTextEventMetadata({
      streamIdentity: exactSnapshot.streams[0].streamIdentity,
      liveSeq: 42,
      liveTextMode: 'append',
    })).toEqual({
      streamIdentity: exactSnapshot.streams[0].streamIdentity,
      liveSeq: 42,
      liveTextMode: 'append',
    });
    expect(liveTextEventMetadata({
      streamIdentity: exactSnapshot.streams[0].streamIdentity,
      liveSeq: 0,
      liveTextMode: 'append',
    })).toBeNull();
  });

  test('capped snapshot은 partial UI를 만들지 않고 durable final 대기 identity로 남긴다', () => {
    const snapshot = normalizeLiveTextSnapshot({
      type: 'text_snapshot',
      basedOnEventId: 1003,
      throughLiveSeq: 99,
      streams: [{
        streamIdentity: 'codex_sdk:aXRlbS1iaWc',
        text: null,
        updatedAt: '2026-08-06T00:00:06.000Z',
        truncated: true,
        resetRequired: true,
        recovery: 'durable_final',
      }],
    });

    expect(snapshotStreamingEvents(snapshot)).toEqual([]);
    expect([...resetRequiredStreamIdentities(snapshot)])
      .toEqual(['codex_sdk:aXRlbS1iaWc']);
  });

  test('256KiB 초과 또는 모순된 recovery shape는 fail closed한다', () => {
    expect(LIVE_TEXT_SNAPSHOT_MAX_UTF8_BYTES).toBe(262_144);
    expect(normalizeLiveTextSnapshot({
      ...exactSnapshot,
      streams: [{ ...exactSnapshot.streams[0], text: 'x'.repeat(263_000) }],
    })).toBeNull();
    expect(normalizeLiveTextSnapshot({
      ...exactSnapshot,
      streams: [{
        ...exactSnapshot.streams[0],
        text: null,
        resetRequired: false,
      }],
    })).toBeNull();
  });
});
