// 두 갈래(A 사진 배경, B 배경 없음)가 함께 쓰는 진입. 같은 1면 컴포넌트에 배경 설정만 달리 준다.
import "../_shell/mock-env";
import { useState } from "react";
import { useDashboardStore } from "@seosoyoung/soul-ui";
import { mountMockup } from "../_shell/MockupShell";
import { CardHandoffView } from "../../client/v3/CardHandoffView";
import { FrontPage } from "../../client/v3/FrontPage";
import wallpaperUrl from "../../e2e/readme-demo/wallpaper.jpg";
import { directorGlass, frontPageData, frontPageImage, frontPageNow, frontPageTimeZone } from "./front-page-fixture";

/** 운영 CardHandoff와 같은 보기. 서버로 보내지 않고 입력만 받는다. */
function MockComposer() {
  const [text, setText] = useState("");
  return <CardHandoffView
    composer={{
      text, onChangeText: setText, onSend: () => setText(""),
      placeholder: "새 세션에서 무엇을 할까요", inputLabel: "세션 첫 메시지", label: "세션 시작",
      disabled: !text.trim(), pending: false, files: [], onRemoveFile: () => undefined,
    }}
    folderLabel="📁 ✨ 소울스트림"
    executionLabel={<>서소영 · eiaserinnys · Claude - Opus</>}
    folderOpen={false} onFolderOpenChange={() => undefined}
    executionOpen={false} onExecutionOpenChange={() => undefined}
    folderPicker={null} executionPicker={null}
  />;
}

export function mountFrontPage(wallpaper: "photo" | "plain") {
  const store = useDashboardStore.getState();
  if (wallpaper === "photo") {
    // 정적 묶음에서는 /api/user/background가 없으므로 묶음 안의 같은 그림을 절대 주소로 준다.
    store.setWallpaper({ mode: "photo", customImage: new URL(wallpaperUrl, document.baseURI).href });
    store.setLiquidGlass(directorGlass);
  } else {
    store.setWallpaper({ mode: "plain" });
  }
  mountMockup(<FrontPage data={frontPageData} composer={<MockComposer />} now={frontPageNow}
    timeZone={frontPageTimeZone} imageUrl={frontPageImage} />, { surface: "bare" });
}
