/**
 * ConfigResultMessage — 설정 저장 결과 메시지
 *
 * applied / restart_required / errors 3종 요약을 작은 배너로 표시한다.
 */

import type { SaveResponse } from "../../hooks/useConfigSettings";

export function ConfigResultMessage({ result }: { result: SaveResponse | null }) {
  if (!result) return null;

  return (
    <div className="text-xs space-y-1 mb-2">
      {result.applied.length > 0 && (
        <p className="text-success">
          ✅ {result.applied.length}개 설정 적용됨
        </p>
      )}
      {result.restart_required.length > 0 && (
        <p className="text-accent-amber">
          🔄 {result.restart_required.length}개 설정은 서버 재시작 후
          적용됩니다
        </p>
      )}
      {result.errors.length > 0 && (
        <p className="text-accent-red">
          ❌ {result.errors.join(", ")}
        </p>
      )}
    </div>
  );
}
