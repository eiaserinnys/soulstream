import { useState } from "react";
import {
  Button,
  Dialog,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  FrameLoading,
  FrameNotice,
} from "@seosoyoung/soul-ui";

/** 프레임 로딩 부품의 자리: 높이 고정 패널, 대화상자 본문, 좁은 폭, 포털 대화상자, 실패 안내 자리. */
export function FrameLoadingReviewSample() {
  const [open, setOpen] = useState(false);
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
    <div style={{ display: "flex", flexDirection: "column", height: "calc(var(--v3-space-8) * 6)" }}>
      <FrameNotice>
        <p role="alert">불러오지 못했습니다. 다시 불러오기</p>
      </FrameNotice>
    </div>
    <div>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>포털 대화상자 표본</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup className="max-w-md">
          <DialogHeader><DialogTitle>프레임 로딩 표본</DialogTitle></DialogHeader>
          <DialogPanel>
            <div className="flex min-h-48 flex-col">
              <FrameLoading label="대화상자를 불러오는 중…" />
            </div>
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </div>
  </>;
}
