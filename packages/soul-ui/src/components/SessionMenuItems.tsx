import { Fragment } from "react";
import { MenuItem, MenuSeparator } from "./ui/menu";
import { cn } from "../lib/cn";

export interface SessionMenuAction {
  label: string;
  onClick: () => void | Promise<void>;
  disabled?: boolean;
  description?: string;
  closeOnClick?: boolean;
  className?: string;
}

/** Both responsive surfaces render exactly the same ordered action definitions. */
export function SessionMenuItems({actions, mobile = false}: {
  actions: readonly SessionMenuAction[];
  mobile?: boolean;
}) {
  return actions.map(action => {
    const content = action.description ? <>
      <span>{action.label}</span>
      <span className="max-w-56 whitespace-normal break-keep text-xs text-muted-foreground" role="status">
        {action.description}
      </span>
    </> : action.label;
    return <Fragment key={action.label}>
      {mobile ? <div className="border-t border-border my-1" /> : <MenuSeparator />}
      {mobile ? <button
        className={cn("w-full text-left px-3 py-2 text-sm hover:bg-accent rounded-md disabled:pointer-events-none disabled:opacity-64",
          action.description && "flex flex-col items-start", action.className)}
        disabled={action.disabled} title={action.description} onClick={() => { void action.onClick(); }}
      >{content}</button> : <MenuItem disabled={action.disabled} title={action.description}
        closeOnClick={action.closeOnClick} onClick={() => { void action.onClick(); }}
        className={cn(action.className, action.description && "flex-col items-start gap-0 py-2")}
      >{content}</MenuItem>}
    </Fragment>;
  });
}
