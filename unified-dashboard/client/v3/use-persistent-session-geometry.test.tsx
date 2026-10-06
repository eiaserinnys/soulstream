/** @vitest-environment jsdom */
import { act, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { usePersistentSessionGeometry } from './use-persistent-session-geometry';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it('remeasures the shared anchor and keeps the toggle on the single-line row',async()=>{
 let resize!:()=>void;vi.stubGlobal('ResizeObserver',class{constructor(cb:()=>void){resize=cb}observe(){}disconnect(){}});
 let nextFrame:FrameRequestCallback|undefined;vi.stubGlobal('requestAnimationFrame',(cb:FrameRequestCallback)=>{nextFrame=cb;return 1});vi.stubGlobal('cancelAnimationFrame',vi.fn());
 vi.stubGlobal('matchMedia',()=>({matches:true,addEventListener(){},removeEventListener(){}}));
 const app=createRef<HTMLDivElement>(),header=createRef<HTMLElement>(),main=createRef<HTMLElement>(),composer=createRef<HTMLDivElement>();let layout:any;
 let top=800;
 const rect=(left:number,t:number,width:number,height:number)=>({left,top:t,width,height,right:left+width,bottom:t+height,x:left,y:t,toJSON(){}});
 function Harness(){layout=usePersistentSessionGeometry({app,header,main,composer,enabled:true,showCharacter:true});return <div ref={app}><header ref={header}/><main ref={main}><div ref={composer}><button data-testid="send-button"/></div></main></div>}
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);await act(async()=>root.render(<Harness/>));
 app.current!.getBoundingClientRect=()=>rect(0,0,1440,900);header.current!.getBoundingClientRect=()=>rect(0,0,1440,76);main.current!.getBoundingClientRect=()=>rect(460,76,520,792);composer.current!.getBoundingClientRect=()=>rect(460,top,520,68);composer.current!.querySelector('button')!.getBoundingClientRect=()=>rect(0,0,44,44);
 act(()=>nextFrame!(0));expect(layout.body.width).toBe(184);expect(layout.lineY).toBe(800);expect(layout.toggle.top).toBe(814);
 top=680;act(()=>{resize();nextFrame!(0)});expect(layout.lineY).toBe(680);expect(layout.toggle.top).toBe(694);expect(layout.body.top+layout.body.height).toBe(681);
 act(()=>root.unmount());host.remove();vi.unstubAllGlobals();
});
