import { DashboardIconCap } from "@seosoyoung/soul-ui";
import { Atom } from "lucide-react";

/**
 * atom 대시보드를 새 탭으로 여는 툴바 단추. 주소가 없으면(atom이 연결되지 않았으면) 아무것도 그리지 않는다.
 * 주소는 툴바가 서버의 atom_public_url(useAtomPublicUrl)에서 가져와 넘긴다.
 */
export function AtomDashboardButton({ url, appearance = "default" }: { url: string | null; appearance?: "default" | "bare" }) {
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
