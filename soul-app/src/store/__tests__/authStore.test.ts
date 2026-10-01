jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
}));

import * as SecureStore from 'expo-secure-store';
import { useAuthStore } from '../authStore';

const getItemAsync = jest.mocked(SecureStore.getItemAsync);
const setItemAsync = jest.mocked(SecureStore.setItemAsync);

beforeEach(async () => {
  getItemAsync.mockResolvedValue(null);
  setItemAsync.mockClear();
  useAuthStore.setState({ jwt: null, authRejected: false });
  await useAuthStore.persist.rehydrate();
  setItemAsync.mockClear();
});

test('401 거부 신호는 JWT만 SecureStore에 저장하고 영속 상태에는 포함하지 않는다', () => {
  useAuthStore.getState().setJwt('expired-jwt');
  setItemAsync.mockClear();

  useAuthStore.getState().rejectAuth();

  expect(useAuthStore.getState()).toMatchObject({ jwt: null, authRejected: true });
  const serialized = setItemAsync.mock.calls.at(-1)?.[1];
  expect(serialized).toBeDefined();
  expect(JSON.parse(serialized!).state).toEqual({ jwt: null });
});

test('기존 { jwt } SecureStore 값은 계속 복원되고 일시 거부 신호는 복원되지 않는다', async () => {
  getItemAsync.mockResolvedValue(JSON.stringify({
    state: { jwt: 'legacy-jwt' },
    version: 0,
  }));

  await useAuthStore.persist.rehydrate();

  expect(useAuthStore.getState()).toMatchObject({ jwt: 'legacy-jwt', authRejected: false });
});

test('일반 clear와 새 JWT 저장은 일시 거부 신호를 해제한다', () => {
  useAuthStore.getState().rejectAuth();
  useAuthStore.getState().clear();
  expect(useAuthStore.getState()).toMatchObject({ jwt: null, authRejected: false });

  useAuthStore.getState().rejectAuth();
  useAuthStore.getState().setJwt('new-jwt');
  expect(useAuthStore.getState()).toMatchObject({ jwt: 'new-jwt', authRejected: false });
});

test('같은 scope에서 반복된 401은 거부 상태를 한 번만 전환한다', () => {
  const listener = jest.fn();
  const unsubscribe = useAuthStore.subscribe(listener);

  useAuthStore.getState().rejectAuth();
  useAuthStore.getState().rejectAuth();

  unsubscribe();
  expect(listener).toHaveBeenCalledTimes(1);
});
