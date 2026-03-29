/**
 * 세션 이름 변경 낙관적 업데이트 팩토리
 *
 * API 경로를 config 객체로 주입받아, soul-dashboard와 orchestrator-dashboard
 * 모두에서 사용할 수 있는 세션 이름 변경 함수를 생성합니다.
 */

import { useDashboardStore } from "../stores/dashboard-store";

export interface RenameSessionApiConfig {
  /** 세션 ID를 받아 URL을 반환하는 함수 */
  url: (sessionId: string) => string;
  method?: "PUT" | "PATCH";
}

export interface RenameSessionOperations {
  renameSessionOptimistic: (sessionId: string, displayName: string | null) => Promise<void>;
}

export function createRenameSessionOperation(config: RenameSessionApiConfig): RenameSessionOperations {
  const method = config.method ?? "PUT";

  async function renameSessionOptimistic(
    sessionId: string,
    displayName: string | null,
  ): Promise<void> {
    const { renameSession, catalog } = useDashboardStore.getState();
    const prevDisplayName = catalog?.sessions[sessionId]?.displayName ?? null;

    // 낙관적 업데이트
    renameSession(sessionId, displayName);

    try {
      const res = await fetch(config.url(sessionId), {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName }),
      });
      if (!res.ok) throw new Error(`Rename failed: ${res.status}`);
    } catch (err) {
      // 롤백
      renameSession(sessionId, prevDisplayName);
      console.error("Session rename failed, rolled back:", err);
    }
  }

  return { renameSessionOptimistic };
}

// soul-dashboard 전용 기본 인스턴스 (soul-server API 경로)
export async function renameSessionOptimistic(
  sessionId: string,
  displayName: string | null,
): Promise<void> {
  const { renameSession, catalog } = useDashboardStore.getState();
  const prevDisplayName = catalog?.sessions[sessionId]?.displayName ?? null;

  // 낙관적 업데이트
  renameSession(sessionId, displayName);

  try {
    const res = await fetch(`/api/catalog/sessions/${sessionId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName }),
    });
    if (!res.ok) throw new Error(`Rename failed: ${res.status}`);
  } catch (err) {
    // 롤백
    renameSession(sessionId, prevDisplayName);
    console.error("Session rename failed, rolled back:", err);
  }
}
