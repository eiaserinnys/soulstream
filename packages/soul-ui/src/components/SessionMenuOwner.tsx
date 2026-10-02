import { createContext, useCallback, useContext, useEffect, type ReactNode } from "react";
import type { SessionContextMenuState } from "./SessionContextMenu";

const SessionMenuOwner = createContext<((menu: SessionContextMenuState) => void) | null>(null);
export function SessionMenuOwnerProvider({onOpen,children}: {
  onOpen(menu: SessionContextMenuState): void;
  children: ReactNode;
}) {
  return <SessionMenuOwner.Provider value={onOpen}>{children}</SessionMenuOwner.Provider>;
}
export function useSessionMenu() {
  const open = useContext(SessionMenuOwner);
  return useCallback((sessionId: string, event: {preventDefault():void;stopPropagation():void;clientX:number;clientY:number;currentTarget?:Element}) => {
    if (!open) throw new Error("Session menu owner is required");
    event.preventDefault();
    event.stopPropagation();
    const portalContainer=event.currentTarget?.closest<HTMLElement>('[data-slot="dialog-popup"]');
    open({sessionId,x:event.clientX,y:event.clientY,...(portalContainer ? {portalContainer} : {})});
  }, [open]);
}
/** Board tile state belongs to the board; actions and dialogs belong to the shared owner. */
export function SessionMenuTrigger({contextMenu,onClose}: {
  contextMenu: SessionContextMenuState | null;
  onClose(): void;
}) {
  const open = useContext(SessionMenuOwner);
  useEffect(() => {
    if (!contextMenu) return;
    if (!open) throw new Error("Session menu owner is required");
    open(contextMenu);
    onClose();
  }, [contextMenu,onClose,open]);
  return null;
}
