/**
 * Orchestrator Dashboard - Root App Component
 *
 * soul-ui DashboardLayout에 orchestrator 고유 컴포넌트(NodePanel, NewSessionDialog)를 주입한다.
 */

import { DashboardLayout } from "@seosoyoung/soul-ui";
import { ORCHESTRATOR_API } from "./lib/api-config";
import { NodePanel } from "./components/NodePanel";
import { NewSessionDialog } from "./components/NewSessionDialog";
import { orchestratorSessionProvider } from "./providers/OrchestratorSessionProvider";
import { useNodes } from "./hooks/useNodes";

const getSessionProvider = () => orchestratorSessionProvider;

export function App() {
  // 노드 상태 SSE 구독 (orchestrator-store 업데이트)
  useNodes();

  return (
    <DashboardLayout
      headerTitle="Orchestrator"
      leftPanelBottom={<NodePanel />}
      leftPanelRatio={[7, 3]}
      hideFeatures={["search", "config", "storageToggle", "themeToggle"]}
      newSessionDialog={<NewSessionDialog />}
      getSessionProvider={getSessionProvider}
      externalProvider={orchestratorSessionProvider}
      catalogApiConfig={ORCHESTRATOR_API}
    />
  );
}
