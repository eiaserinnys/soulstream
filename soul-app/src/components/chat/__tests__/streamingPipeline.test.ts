import { handleSessionSseEvent } from '../sseGate';
import { groupChatEvents } from '../groupChatEvents';
import { useChatStore } from '../../../store/chatStore';
import type { SessionEvent } from '../../../api/types';

const SID = 'sess-streaming-pipeline';

function makeRefs() {
  return {
    framePhaseRef: { current: 'live' as const },
    isCatchingUpRef: { current: false },
    historyLoadingRef: { current: false },
    pendingLiveQueueRef: {
      current: [] as Array<{ event: SessionEvent; eid: string }>,
    },
    pendingCatchupQueueRef: {
      current: [] as Array<{ event: SessionEvent; eid: string }>,
    },
  };
}

function makeActions() {
  const store = useChatStore.getState();
  return {
    triggerAnimation: jest.fn(),
    ingestEvent: (event: SessionEvent) => store.mergeEvents(SID, [event]),
    ingestEventsBatch: (events: SessionEvent[]) => store.mergeEvents(SID, events),
    setLastEventId: (id: string) => store.setLastEventId(SID, id),
  };
}

function ingest(
  type: SessionEvent['type'],
  data: Record<string, unknown>,
  eid: string,
  refs = makeRefs(),
) {
  handleSessionSseEvent(type, data, eid, refs, makeActions());
}

function streamStart(key: string) {
  return {
    type: 'text_start',
    item_id: key,
    _live_only: true,
  };
}

function streamDelta(key: string, text: string) {
  return {
    type: 'text_delta',
    item_id: key,
    text,
    raw_event_type: 'item/agentMessage/delta',
    _live_only: true,
  };
}

function streamEnd(key: string) {
  return {
    type: 'text_end',
    item_id: key,
    _live_only: true,
  };
}

function streamFinal(key: string, text: string) {
  return {
    type: 'assistant_message',
    item_id: key,
    content: text,
    raw_event_type: 'item/completed',
    _final_for_live_stream: true,
  };
}

function events() {
  return useChatStore.getState().eventsBySession[SID] ?? [];
}

function renderedTexts() {
  return groupChatEvents(events()).map((item) => {
    if (item.kind !== 'event') return '';
    const data = item.event.data as any;
    return data.text ?? data.content ?? data.delta ?? '';
  });
}

function renderedTypes() {
  return groupChatEvents(events()).map((item) => (
    item.kind === 'event' ? item.event.type : item.kind
  ));
}

describe('RN app-server streaming pipeline', () => {
  beforeEach(() => {
    useChatStore.getState().clearSession(SID);
  });

  it('live-only chunks with a carried EventSource lastEventId stream as one bubble, then fold into final', () => {
    const refs = makeRefs();

    ingest('text_start', streamStart('item-a'), '80', refs);
    ingest('text_delta', streamDelta('item-a', 'Hel'), '80', refs);
    ingest('text_delta', streamDelta('item-a', 'lo'), '80', refs);

    expect(events()).toHaveLength(3);
    expect(new Set(events().map((event) => event.id)).size).toBe(3);
    expect(events()[0].id).toBe('live:text_start:text_start:item-a:empty');
    expect(events()[1].id).toMatch(
      /^live:text_delta:item\/agentMessage\/delta:item-a:text:[a-z0-9]+$/,
    );
    expect(events()[2].id).toMatch(
      /^live:text_delta:item\/agentMessage\/delta:item-a:text:[a-z0-9]+$/,
    );
    expect(events().some((event) => event.id === '80')).toBe(false);
    expect(useChatStore.getState().lastEventIdBySession[SID]).toBeUndefined();
    expect(renderedTexts()).toEqual(['Hello']);
    expect(renderedTypes()).toEqual(['text_delta']);

    ingest('assistant_message', streamFinal('item-a', 'Hello final'), '81', refs);
    ingest('text_end', streamEnd('item-a'), '81', refs);

    expect(useChatStore.getState().lastEventIdBySession[SID]).toBe('81');
    expect(renderedTexts()).toEqual(['Hello final']);
    expect(renderedTypes()).toEqual(['assistant_message']);
  });

  it('replayed identical live-only chunks do not duplicate the streaming text', () => {
    const refs = makeRefs();

    ingest('text_delta', streamDelta('item-a', 'Hel'), '80', refs);
    ingest('text_delta', streamDelta('item-a', 'Hel'), '80', refs);

    expect(events()).toHaveLength(1);
    expect(renderedTexts()).toEqual(['Hel']);
    expect(useChatStore.getState().lastEventIdBySession[SID]).toBeUndefined();
  });

  it('keeps multiple app-server message streams in one user turn separate across live and final phases', () => {
    const refs = makeRefs();

    ingest('text_start', streamStart('item-a'), '120', refs);
    ingest('text_delta', streamDelta('item-a', 'Alpha'), '120', refs);
    ingest('text_end', streamEnd('item-a'), '120', refs);
    ingest('text_start', streamStart('item-b'), '120', refs);
    ingest('text_delta', streamDelta('item-b', 'Beta'), '120', refs);
    ingest('text_end', streamEnd('item-b'), '120', refs);

    expect(renderedTexts()).toEqual(['Alpha', 'Beta']);
    expect(renderedTypes()).toEqual(['text_delta', 'text_delta']);
    expect(useChatStore.getState().lastEventIdBySession[SID]).toBeUndefined();

    ingest('assistant_message', streamFinal('item-a', 'Alpha final'), '121', refs);
    ingest('assistant_message', streamFinal('item-b', 'Beta final'), '122', refs);

    expect(useChatStore.getState().lastEventIdBySession[SID]).toBe('122');
    expect(renderedTexts()).toEqual(['Alpha final', 'Beta final']);
    expect(renderedTypes()).toEqual(['assistant_message', 'assistant_message']);
  });
});
