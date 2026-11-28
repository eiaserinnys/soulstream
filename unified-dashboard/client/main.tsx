/**
 * Unified Dashboard — React 엔트리 포인트
 */

import "./globals.css";
import "./v3/v3-visual-system.css";

import { StrictMode } from "react";
import { I18nextProvider } from "react-i18next";
import { createI18n, resolveLanguage } from "@soulstream/i18n";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";
import { ToastProvider } from "@seosoyoung/soul-ui";
import { AuthProvider } from "@seosoyoung/soul-ui/providers";
import { AuthGate } from "@seosoyoung/soul-ui/components/auth";
import { registerDashboardServiceWorker } from "./pwa/register-dashboard-service-worker";
import { UiEventsRuntime } from "./lib/UiEventsRuntime";
import {ConnectionBoundary} from "./connection/ConnectionBoundary";

void registerDashboardServiceWorker();

const i18n = createI18n(resolveLanguage(localStorage.getItem("soul-language"), navigator.languages));
function applyLanguage(language: string) {
  document.documentElement.lang = language;
  localStorage.setItem("soul-language", language);
}
applyLanguage(i18n.resolvedLanguage ?? i18n.language);
i18n.on("languageChanged", applyLanguage);

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
    <I18nextProvider i18n={i18n}>
    <QueryClientProvider client={queryClient}>
      <ConnectionBoundary>
      <AuthProvider>
        <AuthGate loginTitle="Soul Dashboard">
          <ToastProvider>
            <UiEventsRuntime>
              <App />
            </UiEventsRuntime>
          </ToastProvider>
        </AuthGate>
      </AuthProvider>
      </ConnectionBoundary>
    </QueryClientProvider>
    </I18nextProvider>
  </StrictMode>,
);
