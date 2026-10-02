import type { ComponentProps, ReactNode } from "react";
import { Popover, PopoverTrigger, PopoverPopup } from "@seosoyoung/soul-ui";
import { CardComposer } from "./CardComposer";
import "./v3-cards.css";

/** One layout for the operational handoff and the local review sample. */
export function CardHandoffView({composer,folderLabel,executionLabel,folderOpen,onFolderOpenChange,executionOpen,onExecutionOpenChange,folderPicker,executionPicker,folderButtonLabel,error}: {
 composer:ComponentProps<typeof CardComposer>;
 folderLabel:string;executionLabel:string;folderButtonLabel?:string;
 folderOpen:boolean;onFolderOpenChange(open:boolean):void;
 executionOpen:boolean;onExecutionOpenChange(open:boolean):void;
 folderPicker:ReactNode;executionPicker:ReactNode;error?:string|null;
}) {
 return <><div>
  <div className="v3-card-handoff">
   <div className="v3-card-handoff-controls">
    <Popover open={folderOpen} onOpenChange={onFolderOpenChange}><PopoverTrigger type="button" className="v3-card-handoff-chip control-surface v3-card-handoff-folder rounded-full" disabled={composer.pending} aria-label={folderButtonLabel}>
     <span>{folderLabel}</span><span aria-hidden="true">▾</span>
    </PopoverTrigger><PopoverPopup side="top" align="start" sideOffset={8} className="v3-shell v3-card-folder-picker">{folderPicker}</PopoverPopup></Popover>
    <Popover open={executionOpen} onOpenChange={onExecutionOpenChange}><PopoverTrigger type="button" className="v3-card-handoff-chip control-surface v3-card-handoff-execution rounded-full" disabled={composer.pending} aria-label="실행 조합 선택">
     <span>{executionLabel}</span><span aria-hidden="true">▾</span>
    </PopoverTrigger><PopoverPopup keepMounted side="top" align="start" sideOffset={8} className="v3-shell v3-card-execution-picker">{executionPicker}</PopoverPopup></Popover>
   </div>
   <CardComposer {...composer}/>
  </div>
 </div>{error?<p role="alert" className="v3-card-error">{error}</p>:null}</>;
}
