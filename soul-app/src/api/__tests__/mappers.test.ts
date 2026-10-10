import {
  applySessionUpdated,
  toSession,
  toSessionEndedReconciliation,
} from '../mappers';

describe('toSession — Phase A-bis camelCase 정본', () => {
  test('REST /api/sessions sessionList item(순수 camelCase)을 그대로 Session으로 변환', () => {
    const raw = {
      agentSessionId: 'sess-1',
      displayName: '테스트',
      status: 'running',
      createdAt: '2026-05-16T00:00:00Z',
      updatedAt: '2026-05-16T01:00:00Z',
      sessionType: 'claude',
      lastMessage: {
        type: 'assistant_message',
        preview: '안녕',
        timestamp: '2026-05-16T00:59:00Z',
      },
      clientId: 'c-1',
      metadata: [],
      nodeId: 'eias-shopping',
      folderId: 'f-1',
      lastEventId: 100,
      lastReadEventId: 80,
      callerSessionId: null,
      agentId: 'roselin',
      agentName: '로젤린',
      agentPortraitUrl: '/api/nodes/eias-shopping/agents/roselin/portrait',
      backend: 'claude',
      modelPreset: 'server-preset',
      modelLabel: 'Claude - Opus',
      userName: '서소영',
      userPortraitUrl: '/api/nodes/eias-shopping/users/portrait',
    };
    const s = toSession(raw);
    expect(s.agentSessionId).toBe('sess-1');
    expect(s.displayName).toBe('테스트');
    expect(s.status).toBe('running');
    expect(s.createdAt).toBe('2026-05-16T00:00:00Z');
    expect(s.updatedAt).toBe('2026-05-16T01:00:00Z');
    expect(s.sessionType).toBe('claude');
    expect(s.nodeId).toBe('eias-shopping');
    expect(s.folderId).toBe('f-1');
    expect(s.agentId).toBe('roselin');
    expect(s.agentName).toBe('로젤린');
    expect(s.backend).toBe('claude');
    expect(s.modelPreset).toBe('server-preset');
    expect(s.modelLabel).toBe('Claude - Opus');
    expect(s.userName).toBe('서소영');
    expect(s.userPortraitUrl).toBe('/api/nodes/eias-shopping/users/portrait');
    expect(s.lastMessage?.preview).toBe('안녕');
    expect(s.reviewRequired).toBe(false);
    expect(s.reviewState).toBe('not_required');
    expect(s.lastEventId).toBe(100);
  });

  test('SSE session_created.session(to_session_info MIXED) 입력을 camelCase로 정규화', () => {
    // soul-server to_session_info 결과 — snake + camel 혼재.
    const raw = {
      agent_session_id: 'sess-2',
      status: 'idle',
      prompt: '안녕하세요',
      created_at: '2026-05-16T00:00:00Z',
      updated_at: '2026-05-16T01:00:00Z',
      session_type: 'claude',
      caller_session_id: null,
      metadata: null,
      last_event_id: 5,
      last_read_event_id: 5,
      node_id: 'eias-shopping',
      agentId: 'roselin',
      agentName: '로젤린',
      agentPortraitUrl: '/api/nodes/eias-shopping/agents/roselin/portrait',
      backend: 'codex',
      model_preset: 'server-preset-snake',
      model_label: 'Codex - 5.6 Sol',
      userName: '서소영',
      userPortraitUrl: '/api/nodes/eias-shopping/users/portrait',
    };
    const s = toSession(raw);
    expect(s.agentSessionId).toBe('sess-2');
    expect(s.createdAt).toBe('2026-05-16T00:00:00Z');
    expect(s.updatedAt).toBe('2026-05-16T01:00:00Z');
    expect(s.sessionType).toBe('claude');
    expect(s.nodeId).toBe('eias-shopping');
    expect(s.agentName).toBe('로젤린');
    expect(s.backend).toBe('codex');
    expect(s.modelPreset).toBe('server-preset-snake');
    expect(s.modelLabel).toBe('Codex - 5.6 Sol');
    expect(s.userName).toBe('서소영');
  });

  test('빈 raw → 빈 Session 객체 반환 (agentSessionId="" — 호출자가 skip)', () => {
    const s = toSession({});
    expect(s.agentSessionId).toBe('');
    expect(s.status).toBe('unknown');
  });

  test('null raw도 안전 처리', () => {
    const s = toSession(null);
    expect(s.agentSessionId).toBe('');
    expect(s.displayName).toBeNull();
  });

  test('camelCase가 우선이고, 둘 다 있으면 camelCase 채택', () => {
    const s = toSession({
      agent_session_id: 'snake-only',
      agentSessionId: 'camel-wins',
    });
    expect(s.agentSessionId).toBe('camel-wins');
  });

  test('lastMessage 정규화 — snake/camel 양쪽 입력', () => {
    expect(
      toSession({
        agent_session_id: 's',
        last_message: {
          type: 'user_message',
          preview: 'a',
          timestamp: '2026-05-16T00:00:00Z',
        },
      }).lastMessage?.preview,
    ).toBe('a');
    expect(
      toSession({
        agentSessionId: 's',
        lastMessage: {
          type: 'assistant_message',
          preview: 'b',
          timestamp: '2026-05-16T00:00:01+00:00',
        },
      }).lastMessage?.preview,
    ).toBe('b');
  });

  test.each([
    null,
    {},
    { type: 'tool_start', preview: '도구', timestamp: '2026-05-16T00:00:00Z' },
    { type: 'assistant_message', preview: '   ', timestamp: '2026-05-16T00:00:00Z' },
    { type: 'assistant_message', preview: '응답', timestamp: 'not-an-iso-date' },
  ])('새 session snapshot의 무효 lastMessage %p는 null로 정규화한다', (lastMessage) => {
    expect(toSession({ agentSessionId: 'fresh', lastMessage }).lastMessage).toBeNull();
  });

  test('새 session 정규화는 이전 호출의 유효 preview를 상속하지 않는다', () => {
    expect(toSession({
      agentSessionId: 'old',
      lastMessage: {
        type: 'assistant_message',
        preview: '이전 응답',
        timestamp: '2026-05-16T00:00:00Z',
      },
    }).lastMessage?.preview).toBe('이전 응답');

    expect(toSession({
      agentSessionId: 'fresh',
      lastMessage: null,
    }).lastMessage).toBeNull();
  });

  test('server v2 sessionList hydration의 pendingAttentions를 exact camel wire로 소비한다', () => {
    const pending = {
      id: 'input_request:req-7',
      sourceEventId: 1001,
      sessionId: 'session-a',
      kind: 'input_request',
      requestedAt: '2026-08-06T00:00:02.000Z',
      title: '입력 요청',
      body: '배포할까요?',
      requestId: 'req-7',
      requiresDetail: false,
    };

    expect(toSession({
      agentSessionId: 'session-a',
      pendingAttentions: [pending],
      attentionRevision: 1001,
    })).toMatchObject({
      pendingAttentions: [pending],
      attentionRevision: 1001,
    });
  });

  test('pending attention snapshot의 session identity 또는 revision이 깨지면 승격하지 않는다', () => {
    const raw = {
      id: 'input_request:req-7',
      sourceEventId: 1001,
      sessionId: 'other-session',
      kind: 'input_request',
      requestedAt: '2026-08-06T00:00:02.000Z',
      title: '입력 요청',
      body: '배포할까요?',
      requiresDetail: false,
    };

    expect(toSession({
      agentSessionId: 'session-a',
      pendingAttentions: [raw],
      attentionRevision: 1000,
    })).toMatchObject({
      pendingAttentions: [],
      attentionRevision: 1000,
    });
    expect(toSession({
      agentSessionId: 'session-a',
      pendingAttentions: [raw],
    })).not.toHaveProperty('pendingAttentions');
  });

  test('review 계약은 snake/camel 양쪽을 받고 old-server 누락은 안전 기본값으로 정규화', () => {
    expect(
      toSession({
        agentSessionId: 'camel',
        reviewRequired: true,
        reviewState: 'needs_review',
      }),
    ).toMatchObject({
      reviewRequired: true,
      reviewState: 'needs_review',
    });
    expect(
      toSession({
        agent_session_id: 'snake',
        review_required: true,
        review_state: 'acknowledged',
      }),
    ).toMatchObject({
      reviewRequired: true,
      reviewState: 'acknowledged',
    });
    expect(toSession({ agentSessionId: 'old-server' })).toMatchObject({
      reviewRequired: false,
      reviewState: 'not_required',
    });
    expect(
      toSession({
        agentSessionId: 'invalid',
        reviewRequired: true,
        reviewState: 'unexpected',
      }),
    ).toMatchObject({
      reviewRequired: true,
      reviewState: 'not_required',
    });
  });
});

describe('applySessionUpdated — SSE delta → Partial<Session>', () => {
  test('snake-only payload(emit_session_updated 정본) 정규화', () => {
    const updates = applySessionUpdated({
      agent_session_id: 'sess-1',
      status: 'completed',
      termination_reason: 'completed_ok',
      termination_detail: 'turn finished',
      updated_at: '2026-05-16T02:00:00Z',
      last_event_id: 123,
      last_read_event_id: 100,
      last_assistant_text: '응답',
      session_type: 'claude',
      caller_source: 'soul-app',
      userName: '서소영',
      userPortraitUrl: '/api/u',
      folder_id: 'f-1',
      node_id: 'node-1',
      agent_id: 'roselin',
      agent_name: '로젤린',
      agent_portrait_url: '/api/a',
      backend: 'codex',
      model_label: 'Codex - 5.6 Sol',
    });
    expect(updates.status).toBe('completed');
    expect(updates.terminationReason).toBe('completed_ok');
    expect(updates.terminationDetail).toBe('turn finished');
    expect(updates.lastEventId).toBe(123);
    expect(updates.updatedAt).toBe('2026-05-16T02:00:00Z');
    expect(updates.userName).toBe('서소영');
    expect(updates.userPortraitUrl).toBe('/api/u');
    expect(updates.folderId).toBe('f-1');
    expect(updates.nodeId).toBe('node-1');
    expect(updates.agentId).toBe('roselin');
    expect(updates.agentName).toBe('로젤린');
    expect(updates.agentPortraitUrl).toBe('/api/a');
    expect(updates.backend).toBe('codex');
    expect(updates.modelLabel).toBe('Codex - 5.6 Sol');
    expect(updates.sessionType).toBe('claude');
    expect(Object.keys(updates).sort()).toEqual(
      [
        'agentId',
        'agentName',
        'agentPortraitUrl',
        'backend',
        'folderId',
        'modelLabel',
        'nodeId',
        'sessionType',
        'status',
        'terminationDetail',
        'terminationReason',
        'lastEventId',
        'updatedAt',
        'userName',
        'userPortraitUrl',
      ].sort(),
    );
  });

  test('model label delta는 camel/snake 양쪽을 받고 null로 기존 값을 지울 수 있다', () => {
    expect(applySessionUpdated({ modelLabel: 'Claude - Opus' }))
      .toMatchObject({ modelLabel: 'Claude - Opus' });
    expect(applySessionUpdated({ model_label: null }))
      .toHaveProperty('modelLabel', null);
  });

  test('emit_session_message_updated wire(last_message 보유, user 프로필 부재)도 정상', () => {
    const updates = applySessionUpdated({
      agent_session_id: 'sess-1',
      status: 'running',
      updated_at: '2026-05-16T03:00:00Z',
      last_message: {
        type: 'assistant_message',
        eventId: 42,
        preview: '안녕',
        timestamp: '2026-05-16T03:00:00Z',
      },
    });
    expect(updates.status).toBe('running');
    expect(updates.updatedAt).toBe('2026-05-16T03:00:00Z');
    expect(updates.lastMessage?.preview).toBe('안녕');
    expect(updates.lastMessage?.eventId).toBe(42);
    expect(updates.userName).toBeUndefined();
    expect(updates.userPortraitUrl).toBeUndefined();
  });

  test('200 Unicode code point를 넘는 preview patch는 기존 preview 보존을 위해 생략한다', () => {
    const updates = applySessionUpdated({
      last_message: {
        type: 'assistant_message',
        event_id: 43,
        preview: '🫧'.repeat(201),
        timestamp: '2026-05-16T03:00:00Z',
      },
    });

    expect(updates).not.toHaveProperty('lastMessage');
  });

  test('text_delta session_updated는 preview를 보존하고 updatedAt은 일반 메타로만 반영한다', () => {
    const updates = applySessionUpdated({
      agent_session_id: 'sess-1',
      status: 'running',
      updated_at: '2026-05-16T03:00:01Z',
      last_message: {
        type: 'text_delta',
        preview: '스트리밍 중',
        timestamp: '2026-05-16T03:00:01Z',
      },
    });

    expect(updates.status).toBe('running');
    expect(updates.updatedAt).toBe('2026-05-16T03:00:01Z');
    expect(updates.lastMessage).toBeUndefined();
  });

  test('thinking_delta session_updated도 preview를 보존하고 updatedAt은 일반 메타로만 반영한다', () => {
    const updates = applySessionUpdated({
      agent_session_id: 'sess-1',
      status: 'running',
      updated_at: '2026-05-16T03:00:01Z',
      last_message: {
        type: 'thinking_delta',
        preview: '생각 중',
        timestamp: '2026-05-16T03:00:01Z',
      },
    });

    expect(updates.status).toBe('running');
    expect(updates.updatedAt).toBe('2026-05-16T03:00:01Z');
    expect(updates.lastMessage).toBeUndefined();
  });

  test.each(['text_start', 'text_end', 'tool_start', 'input_request', 'error', 'complete'])(
    '%s session_updated는 무효 preview를 보존하고 updatedAt만 일반 메타로 반영한다',
    (type) => {
      const updates = applySessionUpdated({
        agent_session_id: 'sess-1',
        updated_at: '2026-05-16T03:00:02Z',
        last_message: {
          type,
          preview: `${type} preview`,
          timestamp: '2026-05-16T03:00:02Z',
        },
      });

      expect(updates.updatedAt).toBe('2026-05-16T03:00:02Z');
      expect(updates.lastMessage).toBeUndefined();
    },
  );

  test.each([
    {},
    { last_message: null },
    { last_message: {} },
    {
      last_message: {
        type: 'assistant_message',
        preview: '   ',
        timestamp: '2026-05-16T03:00:02Z',
      },
    },
    {
      last_message: {
        type: 'assistant_message',
        preview: '응답',
        timestamp: 'invalid',
      },
    },
    {
      last_message: {
        type: 'assistant_message',
        preview: '달력상 존재하지 않는 시각',
        timestamp: '2026-02-30T03:00:00Z',
      },
    },
  ])('patch의 missing/null/invalid last_message %p는 기존 preview 보존을 위해 생략한다', (raw) => {
    expect(applySessionUpdated(raw)).not.toHaveProperty('lastMessage');
  });

  test('null user 프로필은 머지하지 않는다 — 기존 store 값 보존', () => {
    const updates = applySessionUpdated({
      agent_session_id: 'sess-1',
      status: 'idle',
      updated_at: '2026-05-16T04:00:00Z',
      userName: null,
      userPortraitUrl: null,
    });
    expect(updates.userName).toBeUndefined();
    expect(updates.userPortraitUrl).toBeUndefined();
  });

  test('review SSE delta는 snake/camel을 정규화하고 누락 필드는 기존 cache 보존을 위해 skip', () => {
    expect(
      applySessionUpdated({
        review_required: true,
        review_state: 'needs_review',
      }),
    ).toEqual({ reviewRequired: true, reviewState: 'needs_review' });
    expect(
      applySessionUpdated({
        reviewRequired: true,
        reviewState: 'acknowledged',
      }),
    ).toEqual({ reviewRequired: true, reviewState: 'acknowledged' });
    expect(applySessionUpdated({ status: 'completed' })).toEqual({
      status: 'completed',
    });
    expect(
      applySessionUpdated({
        review_required: false,
        review_state: 'unexpected',
      }),
    ).toEqual({ reviewRequired: false });
  });

  test('feedLastEventId는 부재/null/0/양수 값을 구별해 snapshot과 delta에 보존한다', () => {
    expect(toSession({ agentSessionId: 'old' })).not.toHaveProperty('feedLastEventId');
    expect(toSession({ agentSessionId: 'legacy', feedLastEventId: null }))
      .toMatchObject({ feedLastEventId: null });
    expect(toSession({ agent_session_id: 'zero', feed_last_event_id: 0 }))
      .toMatchObject({ feedLastEventId: 0 });
    expect(toSession({ agentSessionId: 'current', feedLastEventId: 81 }))
      .toMatchObject({ feedLastEventId: 81 });
    expect(applySessionUpdated({ feed_last_event_id: null }))
      .toEqual({ feedLastEventId: null });
    expect(applySessionUpdated({ feedLastEventId: 82 }))
      .toEqual({ feedLastEventId: 82 });
    expect(applySessionUpdated({})).not.toHaveProperty('feedLastEventId');
  });
});

describe('toSessionEndedReconciliation', () => {
  test('명시된 SSE id와 종료 메타를 guarded store 입력으로 정규화한다', () => {
    expect(toSessionEndedReconciliation({
      status: 'completed',
      termination_reason: 'completed_ok',
      termination_detail: null,
    }, '42')).toEqual({
      status: 'completed',
      terminationReason: 'completed_ok',
      terminationDetail: null,
      lastEventId: 42,
    });

    expect(toSessionEndedReconciliation({
      status: 'completed',
      termination_reason: 'completed_ok',
      termination_detail: null,
      _event_id: 42,
    }, '42')).toEqual({
      status: 'completed',
      terminationReason: 'completed_ok',
      terminationDetail: null,
      lastEventId: 42,
    });
  });

  test('SSE 순서 좌표가 없거나 status가 없는 session_ended는 조정 신호로 쓰지 않는다', () => {
    expect(toSessionEndedReconciliation({ status: 'completed' }, '')).toBeNull();
    expect(toSessionEndedReconciliation({ status: 'completed' }, '0')).toBeNull();
    expect(toSessionEndedReconciliation({ _event_id: 42 }, '42'))
      .toBeNull();
  });
});
