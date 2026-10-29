// 카드 #789 C 시안: Index 결의 1면과 카드 #739 상세. 두 화면은 주소 조각(#card-739)으로 오간다.
import "../_shell/mock-env";
import { useCallback, useEffect, useState } from "react";
import { useDashboardStore } from "@seosoyoung/soul-ui";
import { mountMockup } from "../_shell/MockupShell";
import { CardPageIndex } from "../../client/v3/CardPageIndex";
import { FrontDock, type FrontDockDestination } from "../../client/v3/FrontDock";
import { FrontPageIndex } from "../../client/v3/FrontPageIndex";
import { frontPageData, frontPageImage, frontPageNow, frontPageTimeZone } from "../front-page-789/front-page-fixture";
import { card739 } from "./card-fixture";

type Screen = "front" | "card";
const CARD_HASH = `#card-${card739.number}`;
const screenFromHash = (): Screen => window.location.hash === CARD_HASH ? "card" : "front";

function FrontIndexMockup() {
  const [screen, setScreen] = useState<Screen>(screenFromHash);
  const [destination, setDestination] = useState<FrontDockDestination>(() => screenFromHash() === "card" ? "card" : "pas");
  const [text, setText] = useState("");

  const show = useCallback((next: Screen, push = true) => {
    if (push) window.history.pushState(null, "", next === "card" ? CARD_HASH : window.location.pathname + window.location.search);
    setScreen(next);
    // 상세에서는 「이 카드」가 기본이고, 1면으로 돌아오면 PAS로 둔다. 입력 글은 그대로다.
    setDestination(current => next === "card" ? "card" : current === "card" ? "pas" : current);
    document.querySelector("main")?.scrollTo({ top: 0 });
  }, []);

  useEffect(() => {
    const onPop = () => show(screenFromHash(), false);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [show]);

  const dock = <FrontDock destinations={screen === "card" ? ["card", "pas", "new"] : ["pas", "new"]}
    value={destination} onChange={setDestination} text={text} onChangeText={setText} onSend={() => setText("")}
    pasName="서소영" cardLabel={`#${card739.number} ${card739.title}`} folderLabel="📁 ✨ 소울스트림" executionLabel={<>서소영 · eiaserinnys · Claude - Opus</>} />;

  return <div key={screen} className="fi-screen">
    {screen === "card"
      ? <CardPageIndex card={card739} now={frontPageNow} timeZone={frontPageTimeZone} dock={dock} onBack={() => show("front")} />
      : <FrontPageIndex data={frontPageData} now={frontPageNow} timeZone={frontPageTimeZone} imageUrl={frontPageImage} dock={dock}
        onOpenCard={number => { if (number === card739.number) show("card"); }} />}
  </div>;
}

useDashboardStore.getState().setWallpaper({ mode: "plain" });
mountMockup(<FrontIndexMockup />, { surface: "bare" });
