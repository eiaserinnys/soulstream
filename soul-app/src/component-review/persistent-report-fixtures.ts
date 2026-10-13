import type { ApiClient } from '../api/client';
import { Keyboard, Platform } from 'react-native';
import type { KeyboardEvent, KeyboardEventName } from 'react-native';
import type { MessageContextItem, PersistentReportEntry } from '../api/types';
import { useSessionStore } from '../store/sessionStore';
import { pendingReportReply } from '../lib/persistent-report';

export const reportReviewEntries: PersistentReportEntry[] = [
  { key: 'app', kind: 'ask', title: '앱 보고 확인', card_numbers: [270], context: '앱의 보고 연결을 확인했습니다.',
    action: '쓰던 글에 의견을 덧붙여 주세요.', options: [], state: 'open', answer: '', updated_at: '2026-10-13T00:00:00Z' },
  { key: 'cleanup', kind: 'ask', title: '블로그 저장소 브랜치 정리', card_numbers: [328],
    context: '공개 예시 저장소의 리모트 브랜치를 95개에서 8개로 줄였습니다. 남은 로컬 브랜치와 워크트리는 git으로 직접 지워야 하고, 모두 머지된 것을 확인했습니다.',
    action: '"응" 하시면 지웁니다.', options: ['응'], state: 'open', answer: '', updated_at: '2026-10-13T00:00:00Z' },
  { key: 'result', kind: 'see', title: '결과 보기', card_numbers: [], context: '구현과 관련 검증을 마쳤습니다.',
    action: '[예시 문서](https://example.com/report)를 읽어 주세요.', options: [], state: 'open', answer: '', updated_at: '2026-10-13T00:00:00Z' },
];
let searchKey = '';
let entries: PersistentReportEntry[] = [];
let failNext = false;
const keyboardListeners = new Map<KeyboardEventName, Set<(event: KeyboardEvent) => void>>();
let keyboardVisible = false;
let keyboardInstalled = false;
function keyboardSignal(show: boolean) {
  keyboardVisible = show;
  // The browser has no software-keyboard geometry; this fixture signals visibility only.
  const event: KeyboardEvent = { duration: 0, easing: 'keyboard',
    endCoordinates: { screenX: 0, screenY: window.innerHeight, width: window.innerWidth, height: 0 } };
  const names: KeyboardEventName[] = show ? ['keyboardWillShow', 'keyboardDidShow'] : ['keyboardWillHide', 'keyboardDidHide'];
  for (const name of names) {
    for (const listener of keyboardListeners.get(name) ?? []) listener(event);
  }
}
function installReviewKeyboard() {
  if (Platform.OS !== 'web' || keyboardInstalled) return;
  keyboardInstalled = true;
  const dismiss = Keyboard.dismiss;
  const addListener = Keyboard.addListener.bind(Keyboard);
  // RN web addListener/isVisible are no-ops. Replace only this OS boundary in
  // the report review sample; production pager receives native Keyboard events.
  Keyboard.addListener = (name: KeyboardEventName, listener: (event: KeyboardEvent) => void) => {
    const listeners = keyboardListeners.get(name) ?? new Set<(event: KeyboardEvent) => void>();
    keyboardListeners.set(name, listeners); listeners.add(listener);
    const subscription = addListener(name, listener);
    const remove = subscription.remove.bind(subscription);
    subscription.remove = () => { listeners.delete(listener); remove(); };
    return subscription;
  };
  Keyboard.isVisible = () => keyboardVisible;
  Keyboard.dismiss = () => { dismiss(); keyboardSignal(false); };
}
/** Public REST fixture and explicit live publication; no simulated timer. */
export function createPersistentReportReviewApi(base: ApiClient, search: string): ApiClient {
  installReviewKeyboard();
  if (searchKey !== search) {
    searchKey = search;
    const params = new URLSearchParams(search);
    entries = params.get('reports') === 'none' ? [] : params.get('reports') === 'one' ? [reportReviewEntries[2]] : [...reportReviewEntries];
  }
  const publish = (next: PersistentReportEntry[]) => {
    entries = next;
    useSessionStore.getState().applyPersistentReport('review-pas-1', entries);
  };
  if (typeof window !== 'undefined') Object.assign(window, { __persistentReportFixture: {
    publish, failNextSend: () => { failNext = true; },
    keyboard: keyboardSignal,
  } });
  return {
    ...base,
    listPersistentSessions: async () => {
      const result = await base.listPersistentSessions();
      return { ...result, sessions: result.sessions.map(session => ({ ...session, persistent_report: entries })) };
    },
    getPersistentSession: async id => {
      const result = await base.getPersistentSession(id);
      return { session: { ...result.session, persistent_report: entries } };
    },
    listCards: async (id, query) => {
      const result = await base.listCards(id, query);
      const example = result.cards[0];
      return { cards: example ? [...result.cards, { ...example, number: 270 }, { ...example, number: 328 }] : [] };
    },
    intervene: async (_id, _text, _paths, context?: MessageContextItem[]) => {
      if (failNext) { failNext = false; throw Error('공개 예시: 전송 실패'); }
      const reply = pendingReportReply(context);
      if (reply) publish(entries.map(entry => entry.key === reply.key && entry.kind === 'ask' && entry.state === 'open'
        ? { ...entry, state: 'answered', answer: reply.option, updated_at: '2026-10-13T00:01:00Z' } : entry));
      return { delivered: true };
    },
    dismissPersistentReport: async (_id, key) => {
      publish(entries.filter(entry => entry.key !== key));
      return { ok: true, changed: true, entries: entries.map(({ key, title }) => ({ key, title })), persistent_report: entries };
    },
  } as ApiClient;
}
