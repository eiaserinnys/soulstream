/**
 * Soul Dashboard - Root App Component
 *
 * soul-ui의 DashboardLayout에 soul-dashboard 고유 컴포넌트를 주입합니다.
 */

import { useState } from "react";
import { DashboardLayout } from "@seosoyoung/soul-ui";
import { NodeGraph } from "./components/NodeGraph";
import { SearchModal } from "./components/SearchModal";
import { ConfigModal } from "./components/ConfigModal";
import { NewSessionModal } from "./components/NewSessionModal";
import { getSessionProvider } from "./providers";
import { SOUL_DASHBOARD_API } from "./lib/api-config";

export function App() {
  const [configOpen, setConfigOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  return (
    <>
      <DashboardLayout
        getSessionProvider={getSessionProvider}
        catalogApiConfig={SOUL_DASHBOARD_API}
        centerPanelBottom={
          <div className="flex-1 overflow-hidden h-full bg-muted/50 dark:bg-muted/30">
            <NodeGraph />
          </div>
        }
        newSessionDialog={<NewSessionModal />}
        onSearchClick={() => setSearchOpen(true)}
        onConfigClick={() => setConfigOpen(true)}
      />
      <ConfigModal open={configOpen} onOpenChange={setConfigOpen} />
      <SearchModal open={searchOpen} onOpenChange={setSearchOpen} />
    </>
  );
}
