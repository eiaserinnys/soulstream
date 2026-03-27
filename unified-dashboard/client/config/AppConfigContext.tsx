/**
 * AppConfigContext — /api/config 응답 기반 설정 컨텍스트
 *
 * AuthProvider와의 역할 구분:
 *   - AuthProvider는 자체적으로 /api/auth/config를 fetch하여 authEnabled를 결정한다.
 *   - AppConfig의 auth.enabled는 App.tsx 등 AppConfig 소비자 레이어에서 사용한다.
 *   - 두 관심사는 독립적이며, AppConfig가 변경되어도 AuthProvider 내부 로직은 변경하지 않는다.
 *
 * fallback 기본값 금지:
 *   /api/config 응답이 없으면 명시적으로 에러 상태를 노출한다.
 *   조용한 기본값은 조용한 버그를 만든다 (env-variables 규칙 참조).
 */

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import type { AppConfig } from "./types";

interface AppConfigState {
  config: AppConfig | null;
  loading: boolean;
  error: string | null;
}

const AppConfigContext = createContext<AppConfigState | null>(null);

export function AppConfigProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppConfigState>({
    config: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    fetch("/api/config")
      .then((res) => {
        if (!res.ok) {
          throw new Error(`/api/config returned ${res.status}`);
        }
        return res.json() as Promise<AppConfig>;
      })
      .then((config) => {
        setState({ config, loading: false, error: null });
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        setState({ config: null, loading: false, error: message });
      });
  }, []);

  if (state.loading) {
    return (
      <div className="flex h-screen items-center justify-center text-muted-foreground text-sm">
        Loading configuration...
      </div>
    );
  }

  if (state.error || !state.config) {
    return (
      <div className="flex h-screen items-center justify-center text-destructive text-sm">
        Failed to load /api/config: {state.error ?? "No response"}
      </div>
    );
  }

  return (
    <AppConfigContext.Provider value={state}>
      {children}
    </AppConfigContext.Provider>
  );
}

/**
 * useAppConfig — AppConfig 훅
 *
 * AppConfigProvider 외부에서 호출하면 에러를 throw한다.
 * 이 훅이 반환할 때는 config가 반드시 존재한다 (loading/error는 Provider에서 처리).
 */
export function useAppConfig(): AppConfig {
  const ctx = useContext(AppConfigContext);
  if (!ctx) {
    throw new Error("useAppConfig must be used within AppConfigProvider");
  }
  if (!ctx.config) {
    throw new Error("useAppConfig: config is null (should not happen in provider)");
  }
  return ctx.config;
}
