import { useSessionMenu } from "@seosoyoung/soul-ui";
import { RichSessionRow } from "./RichSessionRow";
import { SessionPanelHeader } from "./WorkspacePanelHeaders";
import { reviewSession } from "./components-review-fixtures";

export function SessionMenuReviewSample() {
  const open = useSessionMenu();
  return <>
    <RichSessionRow session={reviewSession} onOpen={()=>undefined}
      onContextMenu={(session,event)=>open(session.agentSessionId,event)}/>
    <SessionPanelHeader session={reviewSession} streamActive={false}
      connectionStatus="connected" reconnect={()=>undefined}/>
  </>;
}
