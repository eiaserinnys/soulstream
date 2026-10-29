import { useRef, type ComponentProps, type ReactNode } from "react";
import { Popover, PopoverTrigger, PopoverPopup } from "@seosoyoung/soul-ui";
import { CardComposer } from "./CardComposer";
import "./v3-cards.css";

/** One layout for the operational handoff and the local review sample.
 * `leading` sits before the chips (e.g. a destination toggle); a defined `target`
 * replaces the folder and execution chips for destinations that need no choice. */
export function CardHandoffView({composer,folderLabel,executionLabel,folderOpen,onFolderOpenChange,executionOpen,onExecutionOpenChange,folderPicker,executionPicker,folderButtonLabel,error,executionInvalid,leading,target}: {
 composer:ComponentProps<typeof CardComposer>;
 folderLabel:string;executionLabel:ReactNode;folderButtonLabel?:string;
 folderOpen:boolean;onFolderOpenChange(open:boolean):void;
 executionOpen:boolean;onExecutionOpenChange(open:boolean):void;executionInvalid?:boolean;
 folderPicker:ReactNode;executionPicker:ReactNode;error?:string|null;
 leading?:ReactNode;target?:ReactNode;
}) {
 const executionPopup=useRef<HTMLDivElement>(null);
 return <><div>
  <div className="v3-card-handoff">
   <div className="v3-card-handoff-controls">
    {leading}
    {target!==undefined?target:<>
    <Popover open={folderOpen} onOpenChange={onFolderOpenChange}><PopoverTrigger type="button" className="v3-card-handoff-chip control-surface v3-card-handoff-folder rounded-full" disabled={composer.pending} aria-label={folderButtonLabel}>
     <span>{folderLabel}</span><span aria-hidden="true">▾</span>
    </PopoverTrigger><PopoverPopup side="top" align="start" sideOffset={8} className="v3-shell v3-card-folder-picker">{folderPicker}</PopoverPopup></Popover>
    <Popover open={executionOpen} onOpenChange={onExecutionOpenChange}><PopoverTrigger type="button" className="v3-card-handoff-chip control-surface v3-card-handoff-execution rounded-full" data-invalid={executionInvalid?"true":undefined} disabled={composer.pending} aria-label="실행 조합 선택">
     <span>{executionLabel}</span><span aria-hidden="true">▾</span>
    </PopoverTrigger><PopoverPopup keepMounted ref={executionPopup} initialFocus={executionPopup} side="top" align="start" sideOffset={8} className="v3-shell v3-card-execution-picker">{executionPicker}</PopoverPopup></Popover>
    </>}
   </div>
   <CardComposer {...composer} embedded/>
  </div>
 </div>{error?<p role="alert" className="v3-card-error v3-card-handoff-error">{error}</p>:null}</>;
}
