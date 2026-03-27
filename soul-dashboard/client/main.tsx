/**
 * Soul Dashboard - React 엔트리 포인트
 */

import "./globals.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { AuthProvider, AuthGate } from "@seosoyoung/soul-ui";

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");

createRoot(root).render(
  <StrictMode>
    <AuthProvider>
      <AuthGate loginTitle="Soul Dashboard">
        <App />
      </AuthGate>
    </AuthProvider>
  </StrictMode>,
);
