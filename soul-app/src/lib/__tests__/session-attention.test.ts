import {
  applyPendingAttentionDelta,
  createPendingAttentionVersionState,
  normalizePendingAttentionSnapshot,
} from '../session-attention';
import type { PendingAttention } from '../../api/types';

const SID = 'session-a';

function attention(id: string, sourceEventId: number): PendingAttention {
  return {
    id,
    sourceEventId,
    sessionId: SID,
    kind: 'input_request',
    requestedAt: `2026-08-06T00:00:${String(sourceEventId % 60).padStart(2, '0')}.000Z`,
    title: '입력 요청',
    body: `${id} 응답이 필요합니다`,
    requestId: id,
    requiresDetail: false,
  };
}

describe('session feed v2 pending attention contract (server 7caf0414)', () => {
  test('exact hydration fixture를 정규화하고 snapshot revision을 stale delta 하한으로 둔다', () => {
    const raw = attention('input_request:req-7', 1001);

    expect(normalizePendingAttentionSnapshot([raw], 1001, SID)).toEqual({
      pendingAttentions: [raw],
      attentionRevision: 1001,
    });
    expect(createPendingAttentionVersionState(1001)).toEqual({
      snapshotBaseline: 1001,
      revisionsById: {},
    });
  });

  test('16KiB를 넘는 payload는 상세 전용으로 낮추고 title/body를 bounded copy로 만든다', () => {
    const oversized = {
      ...attention('tool_approval:huge', 1010),
      kind: 'tool_approval',
      title: '제'.repeat(260),
      body: '본'.repeat(260),
      toolInput: { command: 'x'.repeat(17 * 1024) },
    };

    const snapshot = normalizePendingAttentionSnapshot([oversized], 1010, SID);
    expect(snapshot?.pendingAttentions[0]).toMatchObject({
      id: 'tool_approval:huge',
      requiresDetail: true,
      title: '제'.repeat(200),
      body: '본'.repeat(200),
    });
    expect(snapshot?.pendingAttentions[0]).not.toHaveProperty('toolInput');
  });

  test('oversized payload는 긴 optional field도 compact copy에 남기지 않는다', () => {
    const oversized = {
      ...attention('tool_approval:huge-optional', 1011),
      kind: 'tool_approval',
      toolName: 'x'.repeat(17 * 1024),
    };

    const snapshot = normalizePendingAttentionSnapshot([oversized], 1011, SID);
    expect(snapshot?.pendingAttentions[0]).toMatchObject({
      id: 'tool_approval:huge-optional',
      requiresDetail: true,
    });
    expect(snapshot?.pendingAttentions[0]).not.toHaveProperty('toolName');
    expect(JSON.stringify(snapshot?.pendingAttentions[0]).length).toBeLessThan(16 * 1024);
  });

  test('revision은 key별로 적용해 A=110 뒤에 도착한 B=105를 버리지 않는다', () => {
    const initial = [attention('input_request:a', 100)];
    let versions = createPendingAttentionVersionState(100);

    const a = applyPendingAttentionDelta(
      initial,
      100,
      versions,
      SID,
      {
        'input_request:a': {
          revision: 110,
          value: attention('input_request:a', 110),
        },
      },
      110,
    );
    versions = a.versionState;
    const b = applyPendingAttentionDelta(
      a.pendingAttentions,
      a.attentionRevision,
      versions,
      SID,
      {
        'input_request:b': {
          revision: 105,
          value: attention('input_request:b', 105),
        },
      },
      105,
    );

    expect(b.pendingAttentions.map((item) => item.id).sort()).toEqual([
      'input_request:a',
      'input_request:b',
    ]);
    expect(b.attentionRevision).toBe(110);
    expect(b.versionState.revisionsById).toMatchObject({
      'input_request:a': 110,
      'input_request:b': 105,
    });
  });

  test('tombstone revision을 보존해 늦은 upsert가 해제된 identity를 되살리지 못한다', () => {
    const id = 'input_request:req-7';
    const versions = createPendingAttentionVersionState(1001);
    const cleared = applyPendingAttentionDelta(
      [attention(id, 1001)],
      1001,
      versions,
      SID,
      { [id]: { revision: 1002, value: null } },
      1002,
    );
    const stale = applyPendingAttentionDelta(
      cleared.pendingAttentions,
      cleared.attentionRevision,
      cleared.versionState,
      SID,
      { [id]: { revision: 1001, value: attention(id, 1001) } },
      1001,
    );

    expect(stale.pendingAttentions).toEqual([]);
    expect(stale.versionState.revisionsById[id]).toBe(1002);
  });

  test('record key/value identity 또는 session identity가 다르면 delta를 거부한다', () => {
    const current = [attention('input_request:a', 100)];
    const versions = createPendingAttentionVersionState(100);
    const result = applyPendingAttentionDelta(
      current,
      100,
      versions,
      SID,
      {
        'input_request:b': {
          revision: 101,
          value: { ...attention('input_request:c', 101), sessionId: 'session-b' },
        },
      },
      101,
    );

    expect(result.pendingAttentions).toBe(current);
    expect(result.versionState).toBe(versions);
  });
});
