import { useChatTypography } from "@seosoyoung/soul-ui/components/chat/useChatTypography";
import { useRef } from "react";
import { ChatInputComposer } from "@seosoyoung/soul-ui/components/chat/ChatInputComposer";
import { ChatInputEditor } from "@seosoyoung/soul-ui/components/chat/ChatInputEditor";
import { PaperclipButton } from "@seosoyoung/soul-ui/components/chat/PaperclipButton";
import { useTextareaAutoHeight } from "@seosoyoung/soul-ui/components/chat/useTextareaAutoHeight";
import { FileAttachmentPreview } from "@seosoyoung/soul-ui/components/FileAttachmentPreview";
import type { UploadedFile } from "@seosoyoung/soul-ui/hooks/useFileUpload";

export function CardComposer({text,onChangeText,onSend,placeholder,inputLabel,label,disabled,pending,files,onAddFiles,onRemoveFile,onAttachUnavailable}: {
 text:string;onChangeText(text:string):void;onSend():void;placeholder:string;inputLabel?:string;label:string;disabled:boolean;pending:boolean;
 files:UploadedFile[];onAddFiles?(files:FileList|File[]):void;onRemoveFile(id:string):void;onAttachUnavailable?():void;
}) {
 const {chatTypographyStyle}=useChatTypography();
 const textarea=useRef<HTMLTextAreaElement>(null),fileInput=useRef<HTMLInputElement>(null);
 useTextareaAutoHeight(textarea,text);
 return <div className="v3-chat-surface shrink-0 pt-2" style={chatTypographyStyle} data-testid="card-composer"
  onDragOver={event=>{if(onAddFiles&&!pending&&event.dataTransfer.types.includes("Files"))event.preventDefault();}}
  onDrop={event=>{if(onAddFiles&&!pending&&event.dataTransfer.files.length){event.preventDefault();onAddFiles(event.dataTransfer.files);}}}>
  {files.length?<div className="flex gap-2 overflow-x-auto pb-2">{files.map(file=><FileAttachmentPreview key={file.id} file={file.file} status={file.status} onRemove={()=>onRemoveFile(file.id)}/>)}</div>:null}
  <ChatInputComposer>
   <PaperclipButton disabled={pending} onClick={()=>onAddFiles?fileInput.current?.click():onAttachUnavailable?.()}/>
   <ChatInputEditor ref={textarea} text={text} onChangeText={onChangeText} onSend={onSend} placeholder={placeholder} inputLabel={inputLabel??placeholder}
    buttonLabel={label} modeIcon="" modeLabel={placeholder} borderColor="" buttonVariant="default" disabled={disabled} textareaDisabled={pending}
    onPaste={event=>{if(onAddFiles&&!pending&&event.clipboardData.files.length){event.preventDefault();onAddFiles(event.clipboardData.files);}}}/>
  </ChatInputComposer>
  <input type="file" ref={fileInput} multiple hidden disabled={pending} onChange={event=>{if(event.target.files)onAddFiles?.(event.target.files);event.target.value="";}}/>
 </div>;
}
