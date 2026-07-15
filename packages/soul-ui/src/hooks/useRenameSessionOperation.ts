import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";

import type { RenameSessionOperations } from "../lib/rename-session";

/**
 * 이름 변경 연산을 현재 TanStack Query 경계에 연결한다.
 *
 * v1·v3 어느 표면에서 호출하더라도 dashboard store와 모든 targeted session
 * query가 같은 낙관적 업데이트/롤백 경계를 사용한다.
 */
export function useRenameSessionOperation(operation: RenameSessionOperations) {
  const queryClient = useQueryClient();

  return useCallback(
    (sessionId: string, displayName: string | null) => operation.renameSessionOptimistic(
      sessionId,
      displayName,
      { queryClient },
    ),
    [operation, queryClient],
  );
}
