/**
 * Unified Dashboard — React 엔트리 포인트
 */

import "./globals.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";
import { ToastProvider } from "@seosoyoung/soul-ui";
import { AuthProvider } from "@seosoyoung/soul-ui/providers";
import { AuthGate } from "@seosoyoung/soul-ui/components/auth";
import { AppConfigProvider } from "./config/AppConfigContext";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");

// Provider 중첩 순서 설계:
//   AuthProvider → AuthGate → AppConfigProvider → App
// AppConfigProvider를 AuthGate 안으로 옮겨, /api/config 로드 실패가
// 로그인 화면 도달을 막지 않도록 한다. Login.tsx는 AppConfig를 참조하지 않으므로
// 로그인 전 UX는 그대로 유지된다.
createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <AuthGate loginTitle="Soul Dashboard">
          <AppConfigProvider>
            <ToastProvider>
              <App />
            </ToastProvider>
          </AppConfigProvider>
        </AuthGate>
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>,
);
