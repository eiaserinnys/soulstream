// 시안 C: 홈 플래너 3단 트리아지 장부와 지켜보는 중 선반.
// 운영과 같은 배경 사진과 유리 설정을 쓰고, 본문 틀은 시안이 직접 세운다(surface: "bare").
import { useEffect } from "react";
import { useDashboardStore } from "@seosoyoung/soul-ui";

import { HomePlannerTriageMockup } from "../../client/v3/home-triage-1707/HomePlannerTriageMockup";
import { mountMockup } from "../_shell/MockupShell";
import wallpaperUrl from "../../e2e/readme-demo/wallpaper.jpg?inline";

function Mockup() {
  useEffect(() => {
    const store = useDashboardStore.getState();
    store.setWallpaper({ mode: "photo", customImage: wallpaperUrl });
    store.setLiquidGlass({
      enabled: true,
      blur: 5,
      tint: 0.42,
      specular: 0.25,
      chromatic: 0.8,
      refraction: 66,
    });
  }, []);

  return <HomePlannerTriageMockup />;
}

mountMockup(<Mockup />, { surface: "bare" });
