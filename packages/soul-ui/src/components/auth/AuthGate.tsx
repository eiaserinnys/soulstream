/**
 * AuthGate - 인증 상태에 따라 children 또는 Login을 조건부 렌더링.
 *
 * AuthProvider 내에서 사용해야 합니다.
 * - isLoading: true → 스피너 표시
 * - isAuthenticated: false → Login 페이지 표시
 * - isAuthenticated: true → children 렌더링
 */

import { type ReactNode } from "react";
import { useAuth } from "../../providers/AuthProvider";
import { Spinner } from "../ui/spinner";
import { Login } from "./Login";

interface AuthGateProps {
  children: ReactNode;
  loginTitle?: string;
}

export function AuthGate({ children, loginTitle }: AuthGateProps) {
  const { isLoading, isAuthenticated } = useAuth();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background">
        <Spinner className="w-8 h-8 text-muted-foreground" />
      </div>
    );
  }

  if (!isAuthenticated) return <Login title={loginTitle} />;

  return <>{children}</>;
}
