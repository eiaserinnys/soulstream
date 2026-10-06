import { createPersistentSessionScene } from '../persistentSessionScene';
import { resolvePersistentSessionEntry } from '../../lib/persistent-session-entry';
import type { PersistentSessionResource } from '../../api/persistentSessionEndpoints';

const session = (id: string) => ({ session_id: id, persistent: true } as PersistentSessionResource);

test('중앙 토글과 밀기는 같은 scene을 바꾸고 상세의 back은 목록을 먼저 연다', () => {
  const store = createPersistentSessionScene();
  store.getState().open(session('pas-1'));
  store.getState().toggleScene();
  expect(store.getState()).toMatchObject({ scene: 'cards', selectedCardId: null });
  store.getState().selectCard('card-1');
  store.getState().swipe('right');
  expect(store.getState()).toMatchObject({ scene: 'cards', selectedCardId: null });
  store.getState().swipe('right');
  expect(store.getState().scene).toBe('conversation');
  store.getState().swipe('left');
  store.getState().selectCard('card-1');
  store.getState().toggleScene();
  expect(store.getState()).toMatchObject({ scene: 'conversation', selectedCardId: null });
  expect(store.getState().session?.session_id).toBe('pas-1');
});

test('다른 화면에서 PAS를 열면 대화로 돌아오고 인증 인스턴스끼리 상태를 공유하지 않는다', () => {
  const store = createPersistentSessionScene();
  store.getState().open(session('pas-1'));
  store.getState().selectCard('card-1');
  store.getState().open(session('pas-1'));
  expect(store.getState()).toMatchObject({ scene: 'conversation', selectedCardId: null });
  expect(createPersistentSessionScene().getState().session).toBeNull();
});

test('입구의 0/1/복수와 시작의 마지막 선택 규칙을 구분한다', () => {
  const sessions = [session('pas-1'), session('pas-2')];
  expect(resolvePersistentSessionEntry([], null, false)).toEqual({ kind: 'add' });
  expect(resolvePersistentSessionEntry([], null, true)).toEqual({ kind: 'home' });
  expect(resolvePersistentSessionEntry([sessions[0]], null, false)).toEqual({ kind: 'open', session: sessions[0] });
  expect(resolvePersistentSessionEntry(sessions, 'pas-2', false)).toEqual({ kind: 'choose' });
  expect(resolvePersistentSessionEntry(sessions, 'pas-2', true)).toEqual({ kind: 'open', session: sessions[1] });
  expect(resolvePersistentSessionEntry(sessions, 'removed', true)).toEqual({ kind: 'choose' });
});
