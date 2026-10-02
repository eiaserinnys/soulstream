import { createContext, useContext, useEffect, type ReactNode } from "react";
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
  return (sessionId: string, event: {preventDefault():void;stopPropagation():void;clientX:number;clientY:number}) => {
    if (!open) throw new Error("Session menu owner is required");
    event.preventDefault();
    event.stopPropagation();
    open({sessionId,x:event.clientX,y:event.clientY});
  };
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
