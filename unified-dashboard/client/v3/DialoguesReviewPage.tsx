import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { Button, initTheme, LiquidGlassProvider, WallpaperLayer } from "@seosoyoung/soul-ui";
import { DialogueGallery, type DialogueGalleryGroup } from "./DialogueGallery";
import { dialoguesInventory, type DialogueId } from "./dialogues-inventory";
import { webDialogueGroups } from "./dialogues-gallery-groups";
import { createDialoguesApi } from "./dialogues-api";
import { DialoguesSamples } from "./DialoguesSamples";
import { confirmUserRemoval } from "../components/UserManagementTab";
import { confirmRecurringArchive } from "../components/RecurringJobsTab";
import { confirmPersistentSessionRelease } from "../components/PersistentSessionsTab";
import { V3_CARD_GAP_PX, V3_OUTER_INSET_PX } from "./v3-layout-metrics";
import "./v3-dashboard-styles";

export function DialoguesReviewPage() {
  const sample = new URLSearchParams(window.location.search).get("sample");
  if (sample !== null) {
    const item = dialoguesInventory.find(item => item.id === sample);
    return item ? <DialogueSamplePage id={item.id}/> : <p role="status">샘플을 찾을 수 없습니다.</p>;
  }
  const groups: DialogueGalleryGroup[] = webDialogueGroups.map(group => ({
    id: group.id, title: group.title,
    items: group.ids.map(id => {
      const item = dialoguesInventory.find(item => item.id === id)!;
      const native = isNativeConfirm(id);
      return { id, title: item.name,
        src: native ? undefined : `/dialogues?sample=${encodeURIComponent(id)}`,
        onOpen: native ? () => openNativeConfirm(id) : undefined,
        description: native ? "브라우저 기본 확인창은 나란히 표시할 수 없습니다. 버튼으로 실제 창을 엽니다." : item.component,
        mobile: ["v3-sheet", "folder-sheet", "session-sheet"].includes(id),
      };
    }),
  }));
  return <DialogueGallery platform="web" groups={groups}
    description="같은 종류의 실제 창을 옆으로 넘겨 비교합니다. 저장·삭제·생성은 각 미리보기의 샘플에만 적용됩니다."/>;
}

const nativeConfirmIds: readonly DialogueId[] = ["confirm-user", "confirm-recurring", "confirm-persistent-session-release"];
const isNativeConfirm = (id: DialogueId) => nativeConfirmIds.includes(id);

function openNativeConfirm(id: DialogueId) {
  if (id === "confirm-user") return confirmUserRemoval("sample@example.invalid");
  if (id === "confirm-persistent-session-release") return confirmPersistentSessionRelease("서소영 관제");
  return confirmRecurringArchive("검수 반복 작업");
}

function DialogueSamplePage({ id }: { id: DialogueId }) {
  const api = useMemo(() => createDialoguesApi(), []);
  const [open, setOpen] = useState(true);
  const [opening, setOpening] = useState(0);
  const [notice, setNotice] = useState("샘플 창을 닫았습니다.");
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  useEffect(() => { initTheme(); }, []);
  const native = isNativeConfirm(id);
  const embedded = new URLSearchParams(window.location.search).get("embedded") === "1";
  // Dialog overlays already own their CSS glass surface. No catalog load or WebGL canvas is needed here.
  return <LiquidGlassProvider renderDefaultCanvas={false}>
    <div ref={setHost} className="v3-shell v3-dialogue-sample-page isolate font-sans" data-testid="dialogue-sample" data-embedded={embedded ? "true" : undefined}
      style={{ "--v3-card-gap": `${V3_CARD_GAP_PX}px`, "--v3-outer-inset": `${V3_OUTER_INSET_PX}px` } as CSSProperties}>
      <WallpaperLayer/>
      {!native && open ? host ? <DialoguesSamples key={opening} id={id} api={api} onClose={() => setOpen(false)}
        onChanged={() => setNotice(`샘플 변경 ${api.mutations.length}건 · ${api.mutations.at(-1) ?? "변경 없음"}`)}/> :
        null :
        <div className="v3-dialogue-sample-closed">
          <p className="v3-components-label" role="status">{native ? "브라우저 기본 확인창은 버튼으로 엽니다." : notice}</p>
          <Button variant="outline" onClick={() => {
            if (native) { const accepted = openNativeConfirm(id); setNotice(accepted ? "확인" : "취소"); }
            else { setOpening(value => value + 1); setOpen(true); }
          }}>{native ? "확인창 열기" : "다시 열기"}</Button>
        </div>}
    </div>
  </LiquidGlassProvider>;
}
