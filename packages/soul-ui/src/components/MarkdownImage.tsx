/** The image presentation already used in chat markdown. */
export function MarkdownImage({src,alt="",onOpen,variant="default"}:{src?:string;alt?:string;onOpen?(src:string,alt:string):void;variant?:"default"|"card-evidence"}) {
 return <img src={src} alt={alt} className={`max-w-full rounded my-1.5${variant==="card-evidence"?" v3-card-evidence-image":""}${onOpen?" outline-none focus-visible:ring-2 focus-visible:ring-ring":""}`} loading="lazy"
  role={onOpen?"button":undefined} tabIndex={onOpen?0:undefined}
  onClick={onOpen&&src?event=>{event.stopPropagation();onOpen(src,alt);}:undefined}
  onKeyDown={onOpen&&src?event=>{if(event.key==="Enter"||event.key===" "){event.preventDefault();event.stopPropagation();onOpen(src,alt);}}:undefined}/>;
}
