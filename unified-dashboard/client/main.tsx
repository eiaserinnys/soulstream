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
import { registerDashboardServiceWorker } from "./pwa/register-dashboard-service-worker";
import { UiEventsRuntime } from "./lib/UiEventsRuntime";

void registerDashboardServiceWorker();

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
//   AuthProvider → AuthGate → UiEventsRuntime → App
// UiEventsRuntime은 AuthGate 안쪽이다. 사용자가 확정된 뒤에만 수집을 시작해야
// 대기열의 임자가 분명해지고, 로그인 전 화면은 계측과 무관하게 남는다.
createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <AuthGate loginTitle="Soul Dashboard">
          <ToastProvider>
            <UiEventsRuntime>
              <App />
            </UiEventsRuntime>
          </ToastProvider>
        </AuthGate>
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>,
);
