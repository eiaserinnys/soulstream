import * as SecureStore from 'expo-secure-store';
import { withDiagnosticStateStorage } from './diagnosticStateStorage';

/**
 * SecureStore adapter for Zustand persist middleware.
 *
 * iOS Keychain 기반 저장이므로 JWT 같은 민감 정보에 적합하다.
 * AsyncStorage는 평문이라 JWT 저장 용도로는 부적합.
 */
export const authStorage = withDiagnosticStateStorage({
  getItem: async (key: string): Promise<string | null> =>
    (await SecureStore.getItemAsync(key)) ?? null,
  setItem: async (key: string, value: string): Promise<void> => {
    await SecureStore.setItemAsync(key, value);
  },
  removeItem: async (key: string): Promise<void> => {
    await SecureStore.deleteItemAsync(key);
  },
}, 'auth');
