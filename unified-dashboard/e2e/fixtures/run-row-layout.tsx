import { useState } from "react";
import { createRoot } from "react-dom/client";
import { PlannerFolderCardView } from "../../client/v3/PlannerFolderCard";
import { reviewFolder, reviewSession } from "../../client/v3/components-review-fixtures";

/** The operational managed-folder row with local state and a long fixture title. */
function ManagedFolderFixture() {
  const [starred, setStarred] = useState(false);
  return <PlannerFolderCardView
    task={reviewFolder("카드 밀도와 계층 최종 QA · 좁은 행의 정보와 액션을 확인하는 긴 제목", "components-managed-long")}
    sessions={[reviewSession]} nodeConnectivity={{ready:true,connectedNodeIds:new Set(["eiaserinnys"])}}
    isInToday={false} folderStar={{starred,pending:false,error:null,toggle:async()=>setStarred(value=>!value)}}
    onOpen={()=>undefined} onComplete={async()=>undefined} onToggleToday={async()=>undefined}
    onMoveToParent={()=>undefined} onRename={()=>undefined}/>
}

export function mountManagedFolderFixture(host: HTMLElement) {
  createRoot(host).render(<ManagedFolderFixture/>);
}
