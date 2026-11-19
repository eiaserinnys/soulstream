// 시안 A: 홈 플래너, PAS, 전용 결재 데스크, 카드 보드와 참고 서재를 한 흐름으로 올린다.
// 운영 라우트는 건드리지 않고, 실제 컴포넌트와 토큰만 시안 전용 화면에서 조립한다.
import "../_shell/mock-env";
import { useDashboardStore } from "@seosoyoung/soul-ui";
import { mountMockup } from "../_shell/MockupShell";
import { ApprovalDeskDashboardMockup } from "../../client/v3/approval-desk-1707/ApprovalDeskDashboardMockup";
import wallpaperUrl from "../../e2e/readme-demo/wallpaper.jpg";

// 정규화는 /api/user/background와 data URL만 허용하므로, 시안에서는 상태를 직접 세운다.
useDashboardStore.setState({
  wallpaper: { mode: "photo", customImage: new URL(wallpaperUrl, document.baseURI).href },
});
useDashboardStore.getState().setLiquidGlass({
  enabled: true,
  blur: 5,
  tint: 0.42,
  specular: 0.25,
  chromatic: 0.8,
  refraction: 66,
});

mountMockup(<ApprovalDeskDashboardMockup />, { surface: "bare" });
