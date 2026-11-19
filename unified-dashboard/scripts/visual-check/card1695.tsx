import React from "react";
import { createRoot } from "react-dom/client";
import "../../client/globals.css";
import "../../client/v3/v3-visual-system.css";
import "../../client/v3/v3-dashboard-styles";
import { LiquidGlassProvider } from "@seosoyoung/soul-ui";
import { FolderDialog } from "@seosoyoung/soul-ui/components/FolderDialog";
import { SessionContinueErrorDialog } from "@seosoyoung/soul-ui/components/SessionDialogViews";

const scene = new URLSearchParams(location.search).get("scene");
createRoot(document.getElementById("root")!).render(<LiquidGlassProvider>
  <main className="v3-shell v3-chat-surface min-h-screen text-foreground">
    {scene === "folder" ? <FolderDialog mode="create" open onOpenChange={() => {}}
      onConfirm={async () => { throw new Error('[createFolder] HTTP 409 Conflict — {"detail":"folder already exists"}'); }} />
      : <SessionContinueErrorDialog error={'[continueSession] HTTP 503 Service Unavailable — {"detail":"node unavailable"}'} onClose={() => {}} />}
  </main>
</LiquidGlassProvider>);
