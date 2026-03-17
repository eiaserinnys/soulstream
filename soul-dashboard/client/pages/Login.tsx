/**
 * Login - 인증 로그인 페이지
 *
 * 대시보드의 다크 테마(Tailwind CSS 변수)를 사용합니다.
 * - Google OAuth: /api/auth/google으로 리다이렉트
 * - Dev 로그인: devModeEnabled: true일 때만 표시 (서버 플래그 기반)
 * - URL 파라미터 에러 처리: ?error=auth_failed, ?error=no_user
 */

import { useState, useEffect } from "react";
import { useAuth } from "../providers/AuthProvider";

const ERROR_MESSAGES: Record<string, string> = {
  auth_failed: "인증에 실패했습니다.",
  no_user: "허용되지 않은 계정입니다.",
};

export function Login() {
  const { devModeEnabled, devLogin } = useAuth();
  const [devEmail, setDevEmail] = useState("");
  const [devName, setDevName] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // OAuth 콜백 에러 파라미터 처리
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const errorParam = params.get("error");
    if (errorParam) {
      setError(ERROR_MESSAGES[errorParam] ?? "인증 중 오류가 발생했습니다.");
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  const handleGoogleLogin = () => {
    // 현재 경로를 return_to로 전달하여 로그인 후 원래 페이지로 복귀
    const returnTo = window.location.pathname;
    const params = returnTo && returnTo !== "/" ? `?return_to=${encodeURIComponent(returnTo)}` : "";
    window.location.href = `/api/auth/google${params}`;
  };

  const handleDevLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!devEmail.trim()) {
      setError("이메일을 입력해주세요.");
      return;
    }
    setIsSubmitting(true);
    setError(null);
    try {
      await devLogin(devEmail.trim(), devName.trim() || undefined);
      // 성공 시 AuthProvider가 isAuthenticated: true로 전환 → AuthGate에서 App 렌더링
    } catch (err) {
      setError(err instanceof Error ? err.message : "로그인에 실패했습니다.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      data-testid="login-page"
      className="flex items-center justify-center min-h-screen bg-background"
    >
      <div className="w-full max-w-sm bg-card border border-border rounded-xl p-8 shadow-lg flex flex-col gap-6">
        {/* 제목 */}
        <div className="text-center">
          <h1 className="text-2xl font-bold text-foreground">Soul Dashboard</h1>
          <p className="text-sm text-muted-foreground mt-1">계속하려면 로그인하세요</p>
        </div>

        {/* 에러 메시지 */}
        {error && (
          <div
            className="text-xs text-accent-red py-2 px-3 rounded-md bg-accent-red/8"
            role="alert"
          >
            {error}
          </div>
        )}

        {/* Google 로그인 */}
        <button
          type="button"
          onClick={handleGoogleLogin}
          data-testid="google-login-button"
          className="flex items-center justify-center gap-3 w-full px-4 py-2.5 bg-white text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors duration-150 font-medium text-sm"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            width="20"
            height="20"
            aria-hidden="true"
          >
            <path
              fill="#4285F4"
              d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
            />
            <path
              fill="#34A853"
              d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
            />
            <path
              fill="#FBBC05"
              d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
            />
            <path
              fill="#EA4335"
              d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
            />
          </svg>
          Sign in with Google
        </button>

        {/* Dev 로그인 (devModeEnabled 서버 플래그 기반) */}
        {devModeEnabled && (
          <>
            <div className="flex items-center gap-3">
              <div className="flex-1 border-t border-border" />
              <span className="text-xs text-muted-foreground">or</span>
              <div className="flex-1 border-t border-border" />
            </div>

            <div className="flex flex-col gap-3">
              <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-[0.05em]">
                Development Login
              </h2>
              <form onSubmit={handleDevLogin} className="flex flex-col gap-3">
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="dev-email" className="text-sm text-muted-foreground">
                    이메일
                  </label>
                  <input
                    type="email"
                    id="dev-email"
                    value={devEmail}
                    onChange={(e) => setDevEmail(e.target.value)}
                    placeholder="developer@example.com"
                    required
                    data-testid="dev-email-input"
                    className="bg-input border border-border rounded-md py-1.5 px-3 text-sm text-foreground outline-none transition-colors duration-150 focus:border-accent-blue/40"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="dev-name" className="text-sm text-muted-foreground">
                    이름 (선택)
                  </label>
                  <input
                    type="text"
                    id="dev-name"
                    value={devName}
                    onChange={(e) => setDevName(e.target.value)}
                    placeholder="Developer"
                    data-testid="dev-name-input"
                    className="bg-input border border-border rounded-md py-1.5 px-3 text-sm text-foreground outline-none transition-colors duration-150 focus:border-accent-blue/40"
                  />
                </div>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  data-testid="dev-login-button"
                  className="w-full py-2 bg-accent-blue border-accent-blue text-white rounded-lg text-sm font-medium hover:bg-accent-blue/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors duration-150"
                >
                  {isSubmitting ? "로그인 중..." : "로그인 (Dev)"}
                </button>
              </form>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
