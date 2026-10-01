import { RunRowFrame, type RunRowAction, type RunRowFrameProps } from "./RunRowFrame";

/** Checked by the dashboard's normal tsc gate; never executed. */
export function checkRowContract(props: RunRowFrameProps) {
  // @ts-expect-error trailing JSX is not a public row slot
  const trailing = <RunRowFrame {...props} trailing={<button/>}/>;
  // @ts-expect-error callers cannot override the frame's layout class
  const classOverride = <RunRowFrame {...props} className="custom-layout"/>;
  // @ts-expect-error callers cannot override the frame's dimensions
  const styleOverride = <RunRowFrame {...props} style={{padding:0}}/>;
  // @ts-expect-error actions are semantic data, not arbitrary JSX
  const jsxAction = <RunRowFrame {...props} actions={<button/>}/>;
  // @ts-expect-error action size is fixed by the frame
  const size: RunRowAction = {kind:"open",label:"열기",onAction:()=>{},size:"default"};
  // @ts-expect-error action styles cannot bypass its role contract
  const style: RunRowAction = {kind:"complete",label:"완료",onAction:()=>{},style:{width:44}};
  // @ts-expect-error custom action classes cannot bypass its role contract
  const actionClass: RunRowAction = {kind:"menu",label:"관리",onAction:()=>{},className:"large"};
  // @ts-expect-error only existing operational action kinds are accepted
  const kind: RunRowAction = {kind:"custom",label:"다른 동작",onAction:()=>{}};
  // @ts-expect-error disclosure must retain its accessible expanded state
  const disclosure: RunRowAction = {kind:"disclosure",label:"펼치기",onAction:()=>{}};
  return [trailing,classOverride,styleOverride,jsxAction,size,style,actionClass,kind,disclosure];
}
