import { useDashboardStore } from "../stores/dashboard-store";

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
