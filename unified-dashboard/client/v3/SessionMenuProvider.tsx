import { useCallback, useMemo, useState, type ReactNode } from "react";
import { SessionContextMenu, SessionMenuOwnerProvider, useDashboardStore, useSessionListProvider,
  type SessionContextMenuState, type SessionSummary } from "@seosoyoung/soul-ui";
import { createPageApiClient } from "@seosoyoung/soul-ui/page";
import { orchestratorSessionProvider } from "../providers";
import { resolveContinueSessionTarget } from "../lib/continue-session";
import { FolderMoveDialog } from "./FolderMoveDialog";
import { SessionSuccessionModal } from "./SessionSuccessionModal";
import { prepareSessionMenuSuccession } from "./prepare-session-menu-succession";
import type { FolderMoveTarget } from "./folder-move-targets";

export function SessionMenuProvider({children,sessions,onRename,onDelete,onMove,onCreated}: {
  children: ReactNode;
  sessions: readonly SessionSummary[];
  onRename(sessionId:string,name:string|null):Promise<void>;
  onDelete(sessionIds:string[]):Promise<void>;
  onMove(sessionId:string,target:FolderMoveTarget):Promise<void>;
  onCreated(session:SessionSummary):void;
}) {
  const [menu,setMenu] = useState<SessionContextMenuState|null>(null);
  const [moveId,setMoveId] = useState<string|null>(null);
  const [succession,setSuccession] = useState<Awaited<ReturnType<typeof prepareSessionMenuSuccession>>|null>(null);
  const api = useMemo(()=>createPageApiClient(),[]);
  const catalog = useDashboardStore(state=>state.catalog);
  const active = useDashboardStore(state=>state.activeSessionSummary);
  const sessionId = menu?.sessionId ?? moveId;
  const ids = useMemo(()=>sessionId ? [sessionId] : [],[sessionId]);
  const targeted = useSessionListProvider({
    sessionIds:ids,getSessionProvider:()=>orchestratorSessionProvider,enabled:ids.length>0,
    streamEnabled:false,initialCatalogLoadEnabled:false,folderCountsEnabled:false,
  });
  const lookup = useMemo(()=>{
    const byId = new Map([...catalog?.sessionList ?? [],...sessions,...targeted.sessions ?? []]
      .map(session=>[session.agentSessionId,session]));
    if (active) byId.set(active.agentSessionId,active);
    return byId;
  },[active,catalog?.sessionList,sessions,targeted.sessions]);
  const findFolderId = (id:string) => catalog?.sessions[id] ? catalog.sessions[id].folderId : lookup.get(id)?.folderId ?? null;
  const onOpen = useCallback((next:SessionContextMenuState)=>setMenu(next),[]);

  return <SessionMenuOwnerProvider onOpen={onOpen}>
    {children}
    <SessionContextMenu contextMenu={menu} onClose={()=>setMenu(null)}
      onRenameSession={onRename} onDeleteSessions={onDelete}
      getSessionName={id=>lookup.get(id)?.displayName ?? ""}
      resolveSessionIds={id=>[id]}
      onRequestMoveSession={setMoveId}
      onContinueSession={async id=>{
        const session=lookup.get(id);
        if (!session) throw new Error("세션 정보를 찾을 수 없습니다.");
        setSuccession(await prepareSessionMenuSuccession(session,findFolderId(id),catalog));
      }}
      getContinueSessionDisabledReason={id=>resolveContinueSessionTarget({session:lookup.get(id),catalog}).disabledReason}
    />
    <FolderMoveDialog api={api} currentFolderId={moveId ? findFolderId(moveId) ?? "" : ""}
      defaultTargets={[]} open={moveId!==null} onClose={()=>setMoveId(null)}
      onMove={async target=>{if (moveId) await onMove(moveId,target);}}
    />
    {succession ? <SessionSuccessionModal {...succession} contextPending={false}
      onClose={()=>setSuccession(null)} onCreated={onCreated} /> : null}
  </SessionMenuOwnerProvider>;
}
