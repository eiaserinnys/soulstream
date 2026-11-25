import { useEffect, useState } from "react";
import { Button, FrameLoading, Input, Switch } from "@seosoyoung/soul-ui";
import { CardApiError, cardRequest } from "@seosoyoung/soul-ui/cards/card-api";
import { useOrchestratorStore } from "../store/orchestrator-store";
import { CardOrchestrationSettingsForm } from "./CardOrchestrationSettingsForm";
interface DispatchSettings {version:number;nodeConcurrency:Record<string,number>;reviewMeetsDependency:boolean;startReleasedDependents:boolean}
export function CardDispatchTab({ api = cardRequest, orchestration }: { api?: typeof cardRequest; orchestration?: import("./CardOrchestrationSettingsForm").CardOrchestrationSettingsService } = {}) {
 const nodes=useOrchestratorStore(s=>s.nodes);
 const [settings,setSettings]=useState<DispatchSettings|null>(null),[values,setValues]=useState<Record<string,number>>({}),[pending,setPending]=useState(false),[error,setError]=useState<string|null>(null),[saved,setSaved]=useState(false);
 const [reviewMeetsDependency,setReviewMeetsDependency]=useState(false),[startReleasedDependents,setStartReleasedDependents]=useState(false);
 const apply=(value:DispatchSettings)=>{setSettings(value);setValues(value.nodeConcurrency);setReviewMeetsDependency(value.reviewMeetsDependency);setStartReleasedDependents(value.startReleasedDependents);};
 const load=async()=>{const {settings}=await api<{settings:DispatchSettings}>("/api/settings/card-dispatch");apply(settings);};
 useEffect(()=>{void load().catch(e=>setError(String(e)));},[]);
 const keys=[...new Set(["default",...nodes.keys(),...Object.keys(values)])];
 return <div className="space-y-8"><form className="space-y-4" onSubmit={e=>{e.preventDefault();if(!settings||pending)return;setPending(true);setError(null);setSaved(false);void api<{settings:DispatchSettings}>("/api/settings/card-dispatch","PUT",{expectedVersion:settings.version,nodeConcurrency:values,reviewMeetsDependency,startReleasedDependents}).then(result=>{apply(result.settings);setSaved(true);}).catch(async e=>{if(e instanceof CardApiError&&e.status===409){await load();setError("설정이 바뀌어 최신 값을 불러왔습니다. 확인 후 다시 저장하세요.");}else setError(String(e));}).finally(()=>setPending(false));}}>
  <h3 className="font-semibold">카드 실행</h3><p className="text-sm text-muted-foreground">노드별 동시 실행 상한</p>
  {settings?keys.map(key=><label key={key} className="flex items-center justify-between gap-4 text-sm"><span>{key==="default"?"기본값":key}</span><Input className="w-24" type="number" min={0} step={1} aria-label={`${key==="default"?"기본값":key} 동시 실행 상한`} placeholder={String(values.default)} value={values[key]??""} disabled={pending} onChange={e=>setValues(current=>{const next={...current};if(e.target.value===""&&key!=="default")delete next[key];else next[key]=Number(e.target.value);return next;})}/></label>):<FrameLoading inline label="불러오는 중…" />}
  {settings?<section className="space-y-4"><h3 className="font-semibold">선행 카드</h3>
   <div className="flex items-center justify-between gap-4"><span>검수 대기도 끝난 것으로 친다</span><Switch aria-label="검수 대기도 끝난 것으로 친다" checked={reviewMeetsDependency} disabled={pending} onCheckedChange={setReviewMeetsDependency}/></div>
   <div className="flex items-center justify-between gap-4"><div><span>풀린 카드를 바로 시작한다</span><p className="text-sm text-muted-foreground">중앙 카드 배정이 켜져 있으면 쓰이지 않는다</p></div><Switch aria-label="풀린 카드를 바로 시작한다" checked={startReleasedDependents} disabled={pending} onCheckedChange={setStartReleasedDependents}/></div>
  </section>:null}
  {error?<p role="alert" className="text-destructive-foreground text-sm" data-v3-selectable-content="true">{error}</p>:null}{saved?<p role="status" className="text-sm" data-v3-selectable-content="true">저장했습니다.</p>:null}<Button type="submit" disabled={!settings||pending}>저장</Button>
 </form><CardOrchestrationSettingsForm service={orchestration}/></div>;
}
