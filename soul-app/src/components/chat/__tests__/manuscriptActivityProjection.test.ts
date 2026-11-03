import type { SessionEvent } from '../../../api/types';
import type { ChatRenderItem } from '../groupChatEvents';
import { groupChatEvents } from '../groupChatEvents';
import { projectManuscriptActivity } from '../manuscriptActivityProjection';

const ev = (id: string, type: SessionEvent['type'], data: Record<string, unknown> = {}): SessionEvent => ({
  id,
  type,
  data,
});

const tool = (id: string, result?: SessionEvent): Extract<ChatRenderItem, { kind: 'tool' }> => ({
  kind: 'tool',
  start: ev(id, 'tool_start', { tool_use_id: `tu-${id}`, tool_name: 'Read' }),
  result,
  key: `tool-${id}`,
});

const thinking = (id: string): ChatRenderItem => ({
  kind: 'event',
  event: ev(id, 'thinking_delta', { thinking: `생각 ${id}` }),
  key: `evt-${id}`,
});

describe('projectManuscriptActivity', () => {
  it('연속 도구와 생각 행을 도구 수를 가진 한 활동 구간으로 묶는다', () => {
    const first = tool('1');
    const thought = thinking('2');
    const second = tool('3');

    expect(projectManuscriptActivity([first, thought, second])).toEqual([
      {
        kind: 'activity',
        key: 'activity-tool-1',
        items: [first, thought, second],
      },
    ]);
  });

  it('도구가 하나인 구간도 접고 생각만 있는 구간은 문단 행으로 둔다', () => {
    const singleTool = tool('2');
    const thought = thinking('1');
    const thoughtOnly = thinking('3');

    expect(projectManuscriptActivity([thought, singleTool])).toEqual([
      {
        kind: 'activity',
        key: 'activity-evt-1',
        items: [thought, singleTool],
      },
    ]);
    expect(projectManuscriptActivity([thoughtOnly])).toEqual([thoughtOnly]);
  });

  it('응답 글, 사용자 발언, 시스템 행에서 구간을 끊는다', () => {
    const first = tool('1');
    const reply = { kind: 'event', event: ev('2', 'assistant_message', { text: '응답' }), key: 'evt-2' } as const;
    const user = { kind: 'event', event: ev('4', 'user_message', { text: '요청' }), key: 'evt-4' } as const;
    const system = { kind: 'event', event: ev('6', 'system', { message: '시스템' }), key: 'evt-6' } as const;
    const second = tool('3');
    const third = tool('5');
    const fourth = tool('7');

    expect(projectManuscriptActivity([first, reply, second, user, third, system, fourth])).toEqual([
      { kind: 'activity', key: 'activity-tool-1', items: [first] },
      reply,
      { kind: 'activity', key: 'activity-tool-3', items: [second] },
      user,
      { kind: 'activity', key: 'activity-tool-5', items: [third] },
      system,
      { kind: 'activity', key: 'activity-tool-7', items: [fourth] },
    ]);
  });

  it('도구 행에 결합된 가시 요약 캡션을 구간 경계로 보존한다', () => {
    const first = tool('1');
    const caption = {
      kind: 'turn-summary',
      key: 'turn-summary-3',
      event: ev('3', 'turn_summary', { content: '요약 본문' }),
      content: '요약 본문',
      anchorEventId: 1,
    } as const;
    const summarizedTool = { ...tool('2'), summaries: [caption] };
    const afterCaption = tool('4');

    expect(projectManuscriptActivity([first, summarizedTool, afterCaption])).toEqual([
      { kind: 'activity', key: 'activity-tool-1', items: [first, { ...summarizedTool, summaries: undefined }] },
      caption,
      { kind: 'activity', key: 'activity-tool-4', items: [afterCaption] },
    ]);
  });

  it('목록에서 그리지 않는 이벤트는 활동 묶음에 들어오지 않는다', () => {
    const grouped = groupChatEvents([
      ev('1', 'tool_start', { tool_use_id: 'tu-1', tool_name: 'Read' }),
      ev('2', 'input_request_responded'),
      ev('3', 'thinking_delta', { thinking: '생각' }),
      ev('4', 'tool_start', { tool_use_id: 'tu-4', tool_name: 'Read' }),
    ]);

    expect(grouped.map((item) => item.kind === 'event' ? item.event.type : item.kind))
      .not.toContain('input_request_responded');
    expect(projectManuscriptActivity(grouped)).toEqual([
      {
        kind: 'activity',
        key: 'activity-tool-1',
        items: [
          expect.objectContaining({ kind: 'tool', key: 'tool-1' }),
          expect.objectContaining({
            kind: 'event',
            event: expect.objectContaining({ type: 'thinking_delta' }),
          }),
          expect.objectContaining({ kind: 'tool', key: 'tool-4' }),
        ],
      },
    ]);
  });

  it('일반 채팅의 원래 렌더 배열을 수정하지 않는다', () => {
    const items = [tool('1'), thinking('2')];
    expect(projectManuscriptActivity(items, false)).toBe(items);
  });
});
