/**
 * 카드 응답의 담당 에이전트 표시 정보를 만든다.
 *
 * 목록과 상세 응답을 내는 HTTP 라우트에서만 부르고, 행 직렬화(serializeCardRow)와
 * MCP 읽기·변경 응답은 건드리지 않는다. 이름·초상화·모델 표시명은 GET /api/sessions
 * 행이 쓰는 live_session_serialization.ts의 함수로 같은 값을 낸다.
 */

export type CardAssigneeSessionLoader = (
  sessionIds: readonly string[],
) => Promise<readonly Record<string, unknown>[]>;

export type CardAssigneeAgentOptions = {
  /** 담당 세션의 agent_id, node_id, model_preset을 한 번에 모아 읽는다. */
  readonly loadSessions: CardAssigneeSessionLoader;
  /** live_session_serialization.ts의 serializeSessionRow로 직렬화한다. */
  readonly serializeSessions: (
    rows: readonly Record<string, unknown>[],
  ) => readonly Record<string, unknown>[];
};

export type CardAssigneeAgentEnricher = {
  enrichCards: (cards: readonly Record<string, unknown>[]) => Promise<void>;
  enrichDetail: (detail: Record<string, unknown>) => Promise<void>;
};

type SessionDisplays = {
  session: (sessionId: string | null) => Record<string, unknown> | null;
  agent: (cardId: string | null) => Record<string, unknown> | null;
};

export function createCardAssigneeAgentEnricher(
  options: CardAssigneeAgentOptions,
): CardAssigneeAgentEnricher {
  async function loadDisplays(
    sessionIds: readonly (string | null)[],
    synthetic: readonly Record<string, unknown>[],
  ): Promise<SessionDisplays> {
    const ids = uniqueStrings(sessionIds);
    const loaded = ids.length === 0 ? [] : await options.loadSessions(ids);
    const serialized = loaded.length === 0 && synthetic.length === 0
      ? []
      : options.serializeSessions([...loaded, ...synthetic]);
    const bySession = new Map<string, Record<string, unknown>>();
    loaded.forEach((row, index) => {
      const sessionId = text(row.session_id);
      if (sessionId !== null) bySession.set(sessionId, serialized[index] ?? {});
    });
    const byCard = new Map<string, Record<string, unknown>>();
    synthetic.forEach((row, index) => {
      byCard.set(text(row.card_id) ?? "", serialized[loaded.length + index] ?? {});
    });
    return {
      session: (sessionId) => sessionId === null ? null : bySession.get(sessionId) ?? null,
      agent: (cardId) => cardId === null ? null : byCard.get(cardId) ?? null,
    };
  }

  return {
    async enrichCards(cards) {
      const displays = await loadDisplays(
        cards.map((card) =>
          card.assigneeKind === "session" ? text(card.assigneeSessionId) : null),
        cards.flatMap(syntheticAgentRow),
      );
      for (const card of cards) card.assigneeAgent = assigneeAgentFor(card, displays);
    },
    async enrichDetail(detail) {
      const card = asRecord(detail.card);
      const sessions = Array.isArray(detail.sessions)
        ? detail.sessions.flatMap((session): Record<string, unknown>[] => {
            const record = asRecord(session);
            return record === null ? [] : [record];
          })
        : [];
      const displays = await loadDisplays(
        [
          ...sessions.map((session) => text(session.sessionId)),
          ...(card !== null && card.assigneeKind === "session" ? [text(card.assigneeSessionId)] : []),
        ],
        card === null ? [] : syntheticAgentRow(card),
      );
      for (const session of sessions) {
        const display = displays.session(text(session.sessionId));
        session.agentName = text(display?.agentName);
        session.agentPortraitUrl = text(display?.agentPortraitUrl);
        session.modelPreset = text(display?.modelPreset);
        session.modelLabel = text(display?.modelLabel);
        session.backend = text(display?.backend);
      }
      if (card !== null) card.assigneeAgent = assigneeAgentFor(card, displays);
    },
  };
}

function assigneeAgentFor(
  card: Record<string, unknown>,
  displays: SessionDisplays,
): Record<string, unknown> | null {
  const kind = card.assigneeKind;
  if (kind !== "session" && kind !== "agent") return null;
  const display = kind === "session"
    ? displays.session(text(card.assigneeSessionId))
    : displays.agent(text(card.id));
  if (display === null) return null;
  const agentId = kind === "session" ? text(display.agentId) : text(card.assigneeAgentId);
  if (agentId === null) return null;
  return {
    agentId,
    nodeId: kind === "session" ? text(display.nodeId) : text(card.nodeId),
    agentName: text(display.agentName),
    portraitUrl: text(display.agentPortraitUrl),
    modelPreset: kind === "session" ? text(display.modelPreset) : text(card.modelPreset),
    modelLabel: text(display.modelLabel),
  };
}

/** 담당이 에이전트인 카드는 세션 행이 없으므로 같은 직렬화 함수에 넣을 행을 만든다. */
function syntheticAgentRow(card: Record<string, unknown>): Record<string, unknown>[] {
  if (card.assigneeKind !== "agent") return [];
  const agentId = text(card.assigneeAgentId);
  if (agentId === null) return [];
  return [{
    card_id: text(card.id) ?? "",
    agent_id: agentId,
    node_id: card.nodeId,
    model_preset: card.modelPreset,
  }];
}

function uniqueStrings(values: readonly (string | null)[]): string[] {
  return [...new Set(values.filter((value): value is string => value !== null && value.length > 0))];
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
