import { DashboardIconCap, useAtomPublicUrl } from "@seosoyoung/soul-ui";
import { Atom } from "lucide-react";

/**
 * atom이 연결되어 있으면 툴바에 보이는 atom 대시보드 단추. 주소는 서버가 브라우저에서 열 수 있다고
 * 알려 준 값(/api/status의 atom_public_url)이며, 없으면 단추를 그리지 않는다.
 */
export function AtomDashboardButton({ appearance = "default" }: { appearance?: "default" | "bare" }) {
  const url = useAtomPublicUrl();
  if (!url) return null;
  return (
    <DashboardIconCap
      label="atom 열기"
      data-testid="atom-dashboard-button"
      appearance={appearance}
      onClick={() => { window.open(url, "_blank", "noopener,noreferrer"); }}
    >
      {appearance === "bare"
        ? <Atom className="size-5" strokeWidth={1.4} absoluteStrokeWidth aria-hidden="true" />
        : <Atom className="size-5" aria-hidden="true" />}
    </DashboardIconCap>
  );
}
