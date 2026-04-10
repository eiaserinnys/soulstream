/**
 * Unified Dashboard — React 엔트리 포인트
 */

import "./globals.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";
import { AuthProvider, AuthGate } from "@seosoyoung/soul-ui";
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

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <AppConfigProvider>
          <AuthGate loginTitle="Soul Dashboard">
            <App />
          </AuthGate>
        </AppConfigProvider>
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>,
);
