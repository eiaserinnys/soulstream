/**
 * AuthProvider - 인증 상태 Context Provider
 *
 * /api/auth/config에서 authEnabled, devModeEnabled를 확인합니다.
 * - authEnabled: false → 인증 없이 접근 허용 (isAuthenticated: true)
 * - authEnabled: true → /api/auth/status로 인증 상태 확인
 * 서버 통신 실패 시 인증을 거부해 로그인 화면으로 보냅니다.
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
  useRef,
  type ReactNode,
} from "react";
import { clearAllDetailCursorStores } from "./detail-cursor-store";

export interface DashboardAccess {
  restricted: boolean;
  allowedFolderIds: string[];
}

export interface AuthUser {
  email: string;
  name: string;
  picture?: string;
  isAdmin?: boolean;
  dashboardAccess?: DashboardAccess;
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
  /** 서버의 현재 인증 상태를 다시 확인 */
  refreshAuthStatus: () => Promise<void>;
  /** 로그아웃 */
  logout: () => Promise<void>;
  /** Dev 로그인 (devModeEnabled: true일 때만 사용) */
  devLogin: (email: string, name?: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function shouldRecheckAuth(input: RequestInfo | URL): boolean {
  if (typeof window === "undefined") return false;

  let url: URL;
  try {
    const requestUrl = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
    url = new URL(requestUrl, window.location.origin);
  } catch {
    return false;
  }

  return url.origin === window.location.origin
    && url.pathname.startsWith("/api/")
    && url.pathname !== "/api/auth/config"
    && url.pathname !== "/api/auth/status";
}

function readAuthenticatedStatus(status: unknown): boolean {
  if (typeof status !== "object" || status === null) {
    throw new Error("Invalid auth status response");
  }
  const authenticated = (status as { authenticated?: unknown }).authenticated;
  if (typeof authenticated !== "boolean") {
    throw new Error("Invalid auth status response");
  }
  return authenticated;
}

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
  const isAuthenticatedRef = useRef(false);
  const authRejectedRef = useRef(false);
  const refreshPromiseRef = useRef<Promise<void> | null>(null);
  const lifecycleGenerationRef = useRef(0);
  const isProviderMountedRef = useRef(false);

  const refreshAuthStatus = useCallback(() => {
    if (!isProviderMountedRef.current) return Promise.resolve();
    if (refreshPromiseRef.current) return refreshPromiseRef.current;
    const generation = lifecycleGenerationRef.current;

    const request = (async () => {
      const res = await fetch("/api/auth/status", { credentials: "same-origin" });
      if (!res.ok) throw new Error(`Auth status check failed: ${res.status}`);
      const status = await res.json();
      if (!isProviderMountedRef.current || lifecycleGenerationRef.current !== generation) return;
      const authenticated = readAuthenticatedStatus(status);

      if (!authenticated && isAuthenticatedRef.current) {
        clearAllDetailCursorStores();
      }
      isAuthenticatedRef.current = authenticated;
      authRejectedRef.current = !authenticated;
      setIsAuthenticated(authenticated);
      setUser(status.user ?? null);
    })();

    const promise = request.finally(() => {
      if (refreshPromiseRef.current === promise) refreshPromiseRef.current = null;
    });
    refreshPromiseRef.current = promise;
    return promise;
  }, []);

  const logout = useCallback(async () => {
    const res = await fetch("/api/auth/logout", {
      method: "POST",
      credentials: "same-origin",
    });
    if (!res.ok) throw new Error(`Logout failed: ${res.status}`);
    clearAllDetailCursorStores();
    isAuthenticatedRef.current = false;
    authRejectedRef.current = true;
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
    const generation = ++lifecycleGenerationRef.current;
    isProviderMountedRef.current = true;
    const originalFetch = globalThis.fetch;
    const observedFetch: typeof fetch = async (input, init) => {
      const response = await originalFetch.call(globalThis, input, init);
      if (isMounted && response.status === 401 && !authRejectedRef.current && shouldRecheckAuth(input)) {
        // A transient failure in the status check must not log the user out.
        void refreshAuthStatus().catch(() => undefined);
      }
      return response;
    };
    globalThis.fetch = observedFetch;

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
          const authenticated = readAuthenticatedStatus(status);
          isAuthenticatedRef.current = authenticated;
          authRejectedRef.current = !isAuthenticatedRef.current;
          setIsAuthenticated(authenticated);
          setUser(status.user ?? null);
        } else {
          // 인증 비활성 → 바이패스 (로그인 없이 접근)
          isAuthenticatedRef.current = true;
          authRejectedRef.current = false;
          setIsAuthenticated(true);
          setUser(null);
        }
      } catch (err) {
        // 통신 실패 시 폴백: 접근 거부 (fail-closed)
        console.error("Auth initialization failed:", err);
        if (isMounted) {
          isAuthenticatedRef.current = false;
          authRejectedRef.current = true;
          setIsAuthenticated(false);
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
      isProviderMountedRef.current = false;
      if (lifecycleGenerationRef.current === generation) lifecycleGenerationRef.current += 1;
      refreshPromiseRef.current = null;
      if (globalThis.fetch === observedFetch) globalThis.fetch = originalFetch;
    };
  }, [refreshAuthStatus]);

  return (
    <AuthContext.Provider
      value={{
        isLoading,
        authEnabled,
        devModeEnabled,
        isAuthenticated,
        user,
        refreshAuthStatus,
        logout,
        devLogin,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}
