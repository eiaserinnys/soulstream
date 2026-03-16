/**
 * AuthProvider - 인증 상태 Context Provider
 *
 * /api/auth/config에서 authEnabled, devModeEnabled를 확인합니다.
 * - authEnabled: false → 인증 없이 접근 허용 (isAuthenticated: true)
 * - authEnabled: true → /api/auth/status로 인증 상태 확인
 * 서버 통신 실패 시 폴백으로 isAuthenticated: true (접근 허용)
 *
 * 쿠키는 same-origin 요청에서 자동으로 전송되므로,
 * 별도의 Authorization 헤더 없이 인증이 동작합니다.
 */

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";

export interface AuthUser {
  email: string;
  name: string;
  picture?: string;
}

export interface AuthContextValue {
  /** 인증 상태 로딩 중 */
  isLoading: boolean;
  /** 인증 활성화 여부 (false = 바이패스 모드) */
  authEnabled: boolean;
  /** dev-login 사용 가능 여부 (서버 플래그 기반) */
  devModeEnabled: boolean;
  /** 인증 완료 여부 */
  isAuthenticated: boolean;
  /** 현재 사용자 정보 */
  user: AuthUser | null;
  /** 로그아웃 */
  logout: () => Promise<void>;
  /** Dev 로그인 (devModeEnabled: true일 때만 사용) */
  devLogin: (email: string, name?: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}

interface AuthProviderProps {
  children: ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [isLoading, setIsLoading] = useState(true);
  const [authEnabled, setAuthEnabled] = useState(false);
  const [devModeEnabled, setDevModeEnabled] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [user, setUser] = useState<AuthUser | null>(null);

  const refreshAuthStatus = useCallback(async () => {
    const res = await fetch("/api/auth/status", { credentials: "same-origin" });
    if (!res.ok) throw new Error(`Auth status check failed: ${res.status}`);
    const status = await res.json();
    setIsAuthenticated(status.authenticated);
    setUser(status.user ?? null);
  }, []);

  const logout = useCallback(async () => {
    const res = await fetch("/api/auth/logout", {
      method: "POST",
      credentials: "same-origin",
    });
    if (!res.ok) throw new Error(`Logout failed: ${res.status}`);
    setIsAuthenticated(false);
    setUser(null);
  }, []);

  const devLogin = useCallback(
    async (email: string, name?: string) => {
      const res = await fetch("/api/auth/dev-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, name }),
        credentials: "same-origin",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Unknown error" }));
        throw new Error(data.error ?? `Dev login failed: ${res.status}`);
      }
      await refreshAuthStatus();
    },
    [refreshAuthStatus],
  );

  useEffect(() => {
    let isMounted = true;

    async function initialize() {
      try {
        // 1. /api/auth/config로 인증 활성 여부 확인
        const configRes = await fetch("/api/auth/config", {
          credentials: "same-origin",
        });
        if (!configRes.ok) throw new Error(`Config fetch failed: ${configRes.status}`);
        const config = await configRes.json();

        if (!isMounted) return;

        setAuthEnabled(config.authEnabled);
        setDevModeEnabled(config.devModeEnabled ?? false);

        if (config.authEnabled) {
          // 2. 인증 활성 → /api/auth/status로 현재 인증 상태 확인
          const statusRes = await fetch("/api/auth/status", {
            credentials: "same-origin",
          });
          if (!statusRes.ok) throw new Error(`Status fetch failed: ${statusRes.status}`);
          const status = await statusRes.json();

          if (!isMounted) return;
          setIsAuthenticated(status.authenticated);
          setUser(status.user ?? null);
        } else {
          // 인증 비활성 → 바이패스 (로그인 없이 접근)
          setIsAuthenticated(true);
          setUser(null);
        }
      } catch (err) {
        // 통신 실패 시 폴백: 접근 허용
        console.error("Auth initialization failed:", err);
        if (isMounted) {
          setIsAuthenticated(true);
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    }

    initialize();

    return () => {
      isMounted = false;
    };
  }, []);

  return (
    <AuthContext.Provider
      value={{
        isLoading,
        authEnabled,
        devModeEnabled,
        isAuthenticated,
        user,
        logout,
        devLogin,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}
