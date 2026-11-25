import { useEffect } from "react";

import { startAgentPortraitSync } from "../stores/agent-portrait-store";

/** 대시보드 최상위 레이아웃에서 한 번 부른다. */
export function useAgentPortraitSync(): void {
  useEffect(() => startAgentPortraitSync(), []);
}
