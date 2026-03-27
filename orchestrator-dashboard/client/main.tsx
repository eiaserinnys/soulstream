import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./globals.css";
import { App } from "./App";
import { AuthProvider, AuthGate } from "@seosoyoung/soul-ui";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthProvider>
      <AuthGate loginTitle="Soulstream Orchestrator">
        <App />
      </AuthGate>
    </AuthProvider>
  </StrictMode>,
);
