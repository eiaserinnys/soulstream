import { useEffect, useState } from "react";
import { DashboardIconCap } from "@seosoyoung/soul-ui";
import { ArrowLeft } from "lucide-react";
import { ComponentsReviewLayout } from "./ComponentsReviewLayout";
import "./ios-components-review.css";

const bundleIndex = "/assets/ios-components/index.html";

// main.tsx's AuthGate owns access. The exported app entry must also check
// /api/auth/status before mounting its public, locally interactive samples.
export function IosComponentsReviewPage({ section }: { section?: "dialogues" } = {}) {
  const dialogues = section === "dialogues";
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(bundleIndex, { method: "HEAD", cache: "no-store", signal: controller.signal })
      .then(response => { if (!controller.signal.aborted) setReady(response.ok); })
      .catch(() => { if (!controller.signal.aborted) setReady(false); });
    return () => controller.abort();
  }, []);

  return <ComponentsReviewLayout syncPreferences={!dialogues}>
    <article className="v3-detail-pane v3-detail-pane--inline v3-ios-components-review" data-testid="ios-components-review">
      <header className="v3-folder-header v3-inline-folder-header">
        <DashboardIconCap label={dialogues ? "웹 다이얼로그로 돌아가기" : "컴포넌트 검수로 돌아가기"} onClick={() => window.location.assign(dialogues ? "/dialogues" : "/components")}>
          <ArrowLeft className="h-4 w-4" />
        </DashboardIconCap>
        <h1 className="v3-ios-components-title">{dialogues ? "iOS 다이얼로그" : "소울앱 컴포넌트"}</h1>
      </header>
      <div className="v3-ios-components-body">
        <p className="v3-components-label">{dialogues ? "iOS 앱 컴포넌트의 웹 미리보기입니다. iOS 기본 창과 전용 효과는 기기에서 확인합니다." : "앱 컴포넌트의 브라우저 미리보기입니다. iOS 전용 효과와 동작은 기기에서 확인합니다."}</p>
        {ready
          ? <iframe className="v3-ios-components-frame" src={dialogues ? bundleIndex + "?section=dialogues" : bundleIndex} title="소울앱 컴포넌트 브라우저 미리보기" />
          : <p role="status" className="v3-components-label">앱 검수 화면을 준비 중입니다</p>}
      </div>
    </article>
  </ComponentsReviewLayout>;
}
