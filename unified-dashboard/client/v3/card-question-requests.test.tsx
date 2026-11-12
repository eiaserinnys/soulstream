/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InternalLinkProvider } from '@seosoyoung/soul-ui/components/InternalLinkProvider';
import { PersistentReportProvider } from '@seosoyoung/soul-ui/components/persistent-report/PersistentReportProvider';
import { useDashboardStore, type PersistentReportEntry } from '@seosoyoung/soul-ui';
import { useCardStore } from '@seosoyoung/soul-ui/cards/card-store';
import type { CardComment, CardDetail, CardQuestion } from '@seosoyoung/soul-ui/cards/card-types';
import { CardDetailPane } from './CardDetailPane';
import { PersistentReportDeck } from './PersistentReportDeck';
import { pasCardQuestion } from './PasCardExpansion';
import { setCardQuestionTarget } from './card-question-target';

vi.mock('./useCardSessionPages', async original => ({ ...await original<typeof import('./useCardSessionPages')>(), useCardSessionPages: () => ({ sessions: [], loading: false }) }));
vi.mock('@seosoyoung/soul-ui/cards/CardSessionVirtualList', () => ({ CardSessionVirtualList: ({ data, itemContent }: any) => <div>{data.map((row: any, index: number) => <div key={index}>{itemContent(index, row)}</div>)}</div> }));
vi.mock('@seosoyoung/soul-ui', async original => ({
  ...await original<typeof import('@seosoyoung/soul-ui')>(),
  useAuth: () => ({ user: null }), useSessionListProvider: () => ({ sessions: [], loading: false }),
}));

const askedAt = '2026-11-12T05:10:00.000Z';
const question: CardQuestion = {
  id: 'q', title: '에이전트 접속 비밀값을 숨길까요?', text: '실행 명령에 비밀값 9개가 그대로 적힙니다.',
  kind: 'choice', options: ['파일로 옮기기', '그대로 두기'],
  optionDetails: [
    { label: '파일로 옮기기', description: '파일 위치만 남깁니다.', recommended: true },
    { label: '그대로 두기' },
  ],
  answer: null, askedAt, answeredAt: null, selectedOption: null,
};
const request: CardQuestion = {
  ...question, id: 'q-request', title: '아이폰 앱을 업데이트해 주십시오', kind: 'request',
  options: ['했어'], optionDetails: [], attachments: [],
};
const card = {
  id: 'inherit', folderId: 'f', number: 1132, title: '카드 제목', request: '요청', brief: '', status: 'blocked', blockedKind: 'question',
  blockedDetail: null, positionKey: 'a', queuePositionKey: null, assigneeKind: 'agent', assigneeAgentId: 'roselin', assigneeUserId: null,
  assigneeSessionId: 'session', nodeId: 'node', modelPreset: 'sol', version: 1, attachments: [], archived: false, createdAt: askedAt, updatedAt: askedAt,
} as CardDetail['card'];
const detailOf = (questions: CardQuestion[], comments: CardComment[] = []): CardDetail => ({
  card, sessions: [], questions, comments, notes: [], nowHistory: [], reports: [],
});
const sheetEntry: PersistentReportEntry & { card_id: string; card_status: string; question_id: string } = {
  key: 'cq_q-1', kind: 'ask', title: '에이전트 접속 비밀값을 숨길까요?', card_numbers: [],
  context: '배경', action: '', options: [], state: 'open', answer: '', updated_at: '2026-11-12T05:20:00.000Z',
  card_id: 'card-1', card_status: 'blocked', question_id: 'q-1',
  question_title: '에이전트 접속 비밀값을 숨길까요?', question_text: '실행 명령에 비밀값 9개가 그대로 적힙니다.',
  question_kind: 'choice',
  question_option_details: [
    { label: '파일로 옮기기', description: '파일 위치만 남깁니다.', recommended: true },
    { label: '그대로 두기' },
  ],
  question_thread: [{ id: 't1', question_id: 'q-1', author_kind: 'user', body: '어떻게 해결 돼?', created_at: askedAt, session_id: null }],
  question_revision: 2, question_revised_at: '2026-11-12T05:18:00.000Z',
};

describe('card question request bodies', () => {
  const cardRow = { ...card, id: 'card-1' };
  const savedComment: CardComment = { id: 'c-question', cardId: 'card-1', authorKind: 'user', authorId: 'sample', sessionId: null, kind: 'comment', questionId: 'q-1', body: '되묻습니다', createdAt: askedAt };
  let request: ReturnType<typeof vi.fn>;
  const respond = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  beforeEach(() => {
    useCardStore.getState().reset();
    request = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/cards/card-1/questions/q-1/answer')) return respond({});
      if (url.endsWith('/api/cards/card-1/comments')) return respond(savedComment);
      if (url.endsWith('/api/cards/card-1')) return respond({ card: cardRow });
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', request);
  });
  afterEach(() => vi.unstubAllGlobals());
  const sent = (path: string) => request.mock.calls.find(([input]) => String(input).endsWith(path))!;
  const body = (path: string) => JSON.parse(String((sent(path)[1] as RequestInit).body));

  it('sends a choice answer with mode and option', async () => {
    await useCardStore.getState().mutate('card-1', '/questions/q-1/answer', { mode: 'choice', option: '파일로 옮기기' });
    expect(sent('/api/cards/card-1/questions/q-1/answer')[1]).toMatchObject({ method: 'POST' });
    expect(body('/api/cards/card-1/questions/q-1/answer')).toEqual({ mode: 'choice', option: '파일로 옮기기', idempotencyKey: expect.any(String) });
  });

  it('sends a free-text answer with mode text', async () => {
    await useCardStore.getState().mutate('card-1', '/questions/q-1/answer', { mode: 'text', answer: '파일로 옮기기만 빼고 진행' });
    expect(body('/api/cards/card-1/questions/q-1/answer')).toEqual({ mode: 'text', answer: '파일로 옮기기만 빼고 진행', idempotencyKey: expect.any(String) });
  });

  it('binds a question comment with questionId', async () => {
    const saved = await useCardStore.getState().addComment('card-1', '되묻습니다', 'key-1', undefined, 'q-1');
    expect(body('/api/cards/card-1/comments')).toEqual({ body: '되묻습니다', idempotencyKey: 'key-1', questionId: 'q-1' });
    expect(saved.questionId).toBe('q-1');
    expect(sent('/api/cards/card-1')).toBeUndefined();
  });
});

describe('card detail question actions', () => {
  let container: HTMLDivElement; let root: Root;
  let mutate: ReturnType<typeof vi.fn>; let addComment: ReturnType<typeof vi.fn>;
  const textarea = () => container.querySelector('textarea')!;
  const exact = (name: string) => [...container.querySelectorAll<HTMLButtonElement>('button')]
    .find(node => (node.getAttribute('aria-label') ?? node.textContent) === name)!;
  const choice = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('button')]
    .find(node => node.textContent?.startsWith(label))!;
  const type = async (value: string) => {
    const input = textarea();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value);
    await act(() => input.dispatchEvent(new Event('input', { bubbles: true })));
  };
  const send = async () => act(async () => {
    textarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    await Promise.resolve(); await Promise.resolve();
  });
  const render = async (questions: CardQuestion[], comments: CardComment[] = []) => {
    const detail = detailOf(questions, comments);
    useCardStore.setState({ byId: { inherit: card }, details: { inherit: detail }, loadCard: vi.fn().mockResolvedValue(detail), mutate, addComment });
    await act(() => root.render(<CardDetailPane cardId="inherit" folders={[]} onClose={() => {}} onOpenSession={() => {}} />));
  };
  beforeEach(() => {
    vi.stubGlobal('PointerEvent', MouseEvent);
    useDashboardStore.setState({ drafts: {} });
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    setCardQuestionTarget('inherit', null);
    mutate = vi.fn().mockResolvedValue(undefined);
    addComment = vi.fn().mockResolvedValue(undefined);
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => { await act(() => root.unmount()); container.remove(); setCardQuestionTarget('inherit', null); useCardStore.getState().reset(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('sends a one-press choice and puts the append target row above the composer', async () => {
    await render([question]);
    await act(async () => { choice('파일로 옮기기').click(); await Promise.resolve(); });
    expect(mutate).toHaveBeenCalledWith('inherit', '/questions/q/answer', { mode: 'choice', option: '파일로 옮기기' });
    expect(container.querySelector('.v3-card-target-notice')?.textContent).toContain('덧붙이기: 파일로 옮기기');
    expect(textarea().getAttribute('placeholder')).toBe('덧붙일 말');
    await type('옮긴 뒤 알려 주세요');
    await send();
    expect(addComment).toHaveBeenCalledWith('inherit', '옮긴 뒤 알려 주세요', expect.any(String), undefined, 'q');
  });

  it('sends the open question composer as a text answer', async () => {
    await render([question]);
    expect(container.querySelector('.v3-card-question-title')?.textContent).toBe(question.title);
    expect(textarea().getAttribute('placeholder')).toBe('다르게 답하기');
    await type('파일로 옮기기만 빼고 진행');
    await send();
    expect(mutate).toHaveBeenCalledWith('inherit', '/questions/q/answer', { mode: 'text', answer: '파일로 옮기기만 빼고 진행' });
    expect(addComment).not.toHaveBeenCalled();
  });

  it('targets a thread reply above the composer and focuses it', async () => {
    await render([question]);
    await act(() => exact('되묻기').click());
    expect(container.querySelector('.v3-card-target-notice')?.textContent).toContain('되묻기');
    expect(textarea().getAttribute('placeholder')).toBe('물어볼 것');
    expect(document.activeElement).toBe(textarea());
    await type('이건 무슨 뜻인가요?');
    await send();
    expect(addComment).toHaveBeenCalledWith('inherit', '이건 무슨 뜻인가요?', expect.any(String), undefined, 'q');
  });

  it('sends 했어 as a choice without an append target', async () => {
    await render([request]);
    expect(container.querySelector('.v3-card-question-choices')).toBeNull();
    await act(async () => { exact('했어').click(); await Promise.resolve(); });
    expect(mutate).toHaveBeenCalledWith('inherit', '/questions/q-request/answer', { mode: 'choice', option: '했어' });
    expect(container.textContent).not.toContain('덧붙이기');
  });

  it('keeps an ordinary comment whose questionId is null and folds question replies into the thread', async () => {
    // 서버는 SELECT * 행을 그대로 내보내 보통 커멘트도 questionId: null로 온다.
    // undefined만 걸러 내면 실제 응답에서 커멘트 탭이 통째로 비어 버린다.
    const ordinary: CardComment = {
      id: 'c-ordinary', cardId: 'inherit', authorKind: 'agent', authorId: 'roselin', sessionId: null,
      kind: 'comment', questionId: null, body: '실행 명령에 실린 값을 세었습니다.', createdAt: askedAt,
    };
    const reply: CardComment = {
      ...ordinary, id: 'c-reply', authorKind: 'user', authorId: 'sample', questionId: 'q', body: '되묻는 말입니다.', createdAt: askedAt,
    };
    await render([question], [ordinary, reply]);
    const entries = [...container.querySelectorAll('[data-card-entry="커멘트"]')];
    expect(entries).toHaveLength(1);
    expect(entries[0]!.textContent).toContain('실행 명령에 실린 값을 세었습니다.');
    expect(container.querySelector('.v3-card-question-thread')?.textContent).toContain('되묻는 말입니다.');
  });
});

describe('PAS deck question actions', () => {
  let host: HTMLDivElement; let root: Root;
  let transport: ReturnType<typeof vi.fn>; let mutate: ReturnType<typeof vi.fn>;
  const button = (name: string) => [...host.querySelectorAll<HTMLButtonElement>('button')]
    .find(node => (node.getAttribute('aria-label') ?? node.textContent) === name)!;
  const choice = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button')]
    .find(node => node.textContent?.startsWith(label))!;
  const render = async (entry: PersistentReportEntry = sheetEntry) => act(async () => root.render(
    <InternalLinkProvider internalOrigins={['https://example.test']} openTarget={() => {}}>
      <PersistentReportProvider sessionId="a" entries={[entry]}>
        <PersistentReportDeck sessionId="a" notify={() => {}} transport={transport} focusInput={() => {}}
          dismissReport={async () => {}} renderCardDetails={() => <div />} renderCardStatus={() => null}
          renderQuestion={pasCardQuestion} />
      </PersistentReportProvider>
    </InternalLinkProvider>,
  ));
  beforeEach(async () => {
    vi.clearAllMocks();
    useDashboardStore.getState().setPendingChatSend('a', null);
    useCardStore.getState().reset();
    mutate = vi.fn().mockResolvedValue(undefined);
    useCardStore.setState({ mutate });
    transport = vi.fn().mockResolvedValue({ ok: true, delivered: true, reason: null, consumeWhen: null });
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return { height: this.classList.contains('pas-report-content') ? 100 : 0 } as DOMRect;
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: function () {} });
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  });
  afterEach(async () => { await act(() => root.unmount()); host.remove(); setCardQuestionTarget('card-1', null); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('keeps a collapsed choice on the existing panel answer path', async () => {
    await render();
    await act(async () => { choice('파일로 옮기기').click(); await Promise.resolve(); await Promise.resolve(); });
    expect(transport).toHaveBeenCalledWith({
      sessionKey: 'a', text: '에이전트 접속 비밀값을 숨길까요?: 파일로 옮기기',
      contextItems: [{ key: 'persistent_report_reply', content: { key: 'cq_q-1', option: '파일로 옮기기' } }],
    });
    expect(mutate).not.toHaveBeenCalled();
    expect(host.textContent).toContain('받은 답');
    expect(host.textContent).toContain('덧붙이기');
  });

  it('sends the expanded choice through the card answer route', async () => {
    await render();
    await act(async () => { button('확대').click(); await Promise.resolve(); });
    await act(async () => { choice('파일로 옮기기').click(); await Promise.resolve(); });
    expect(mutate).toHaveBeenCalledWith('card-1', '/questions/q-1/answer', { mode: 'choice', option: '파일로 옮기기' });
    expect(transport).not.toHaveBeenCalled();
  });

  it('shows the waiting row from the thread and the revised time', async () => {
    await render();
    expect(host.textContent).toContain('답을 기다리는 중');
    expect(host.textContent).toContain(new Date('2026-11-12T05:18:00.000Z').toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) + '에 고침');
  });

  it('sends a collapsed request 했어 as a choice', async () => {
    const asked: PersistentReportEntry = { ...sheetEntry, key: 'cq_q-2', question_id: 'q-2', title: '아이폰 앱을 업데이트해 주십시오', question_title: '아이폰 앱을 업데이트해 주십시오', question_kind: 'request', question_option_details: [], question_thread: [] };
    await render(asked);
    await act(async () => { button('했어').click(); await Promise.resolve(); await Promise.resolve(); });
    expect(transport).toHaveBeenCalledWith(expect.objectContaining({
      contextItems: [{ key: 'persistent_report_reply', content: { key: 'cq_q-2', option: '했어' } }],
    }));
    expect(mutate).not.toHaveBeenCalled();
  });
});
