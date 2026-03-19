/**
 * Soul Dashboard - React 엔트리 포인트
 */

import "./globals.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { AuthProvider, useAuth } from "./providers/AuthProvider";
import { Login } from "./pages/Login";
import { Spinner } from "@seosoyoung/soul-ui";

/**
 * AuthGate - 인증 상태에 따라 App 또는 Login을 조건부 렌더링.
 * react-router 없이 AuthContext 상태로 분기합니다.
 */
function AuthGate() {
  const { isLoading, isAuthenticated } = useAuth();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background">
        <Spinner className="w-8 h-8 text-muted-foreground" />
      </div>
    );
  }

  if (!isAuthenticated) return <Login />;

  return <App />;
}

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");

createRoot(root).render(
  <StrictMode>
    <AuthProvider>
      <AuthGate />
    </AuthProvider>
  </StrictMode>,
);
