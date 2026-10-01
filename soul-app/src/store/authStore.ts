import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import * as SecureStore from 'expo-secure-store';
import { withDiagnosticStateStorage } from './diagnosticStateStorage';

/**
 * SecureStore adapter for Zustand persist middleware.
 *
 * iOS Keychain 기반 저장이므로 JWT 같은 민감 정보에 적합하다.
 * AsyncStorage는 평문이라 JWT 저장 용도로는 부적합.
 */
const secureStorage = withDiagnosticStateStorage({
  getItem: async (key: string): Promise<string | null> =>
    (await SecureStore.getItemAsync(key)) ?? null,
  setItem: async (key: string, value: string): Promise<void> => {
    await SecureStore.setItemAsync(key, value);
  },
  removeItem: async (key: string): Promise<void> => {
    await SecureStore.deleteItemAsync(key);
  },
}, 'auth');

interface AuthState {
  jwt: string | null;
  authRejected: boolean;
  setJwt: (token: string | null) => void;
  clear: () => void;
  rejectAuth: () => void;
}

/**
 * 네이티브 JWT 저장소.
 *
 * - LoginScreen이 PKCE OAuth로 받은 Google id_token을 백엔드
 *   /api/auth/google/native에 POST하여 받은 JWT를 여기에 저장한다.
 * - api/client.ts의 authFetch가 jwt를 읽어 Authorization 헤더에 자동 주입.
 * - 현재 인증 scope의 401은 jwt를 지우고 일시 authRejected 신호를 세워
 *   설정 조회가 실패했더라도 RootNavigator가 LoginScreen으로 복귀하게 한다.
 */
export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      jwt: null,
      authRejected: false,
      setJwt: (jwt) => set({ jwt, authRejected: false }),
      clear: () => set({ jwt: null, authRejected: false }),
      rejectAuth: () => set((state) =>
        state.jwt === null && state.authRejected
          ? state
          : { jwt: null, authRejected: true },
      ),
    }),
    {
      name: 'soul-auth',
      storage: createJSONStorage(() => secureStorage),
      // 기존 저장 shape { jwt }는 유지하고, 거부 신호는 재시작 후 복원하지 않는다.
      partialize: (state) => ({ jwt: state.jwt }),
    }
  )
);
