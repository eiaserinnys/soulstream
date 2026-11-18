import { FrameLoading } from "@seosoyoung/soul-ui";

/** 프레임 로딩 부품의 세 자리: 높이 고정 패널, 대화상자 본문 높이, 좁은 폭. */
export function FrameLoadingReviewSample() {
  return <>
    <div style={{ display: "flex", flexDirection: "column", height: "calc(var(--v3-space-8) * 6)" }}>
      <FrameLoading label="카드를 불러오는 중…" />
    </div>
    <div className="v3-ritual-message">
      <FrameLoading label="이월할 항목을 모으는 중…" />
    </div>
    <div style={{ display: "flex", flexDirection: "column", width: "calc(var(--v3-space-8) * 7)" }}>
      <FrameLoading inline label="폴더를 불러오는 중…" />
    </div>
  </>;
}
