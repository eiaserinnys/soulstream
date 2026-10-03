import { useEffect, useState } from "react";
import { Button, Input } from "@seosoyoung/soul-ui";
import { CardApiError, cardRequest } from "@seosoyoung/soul-ui/cards/card-api";
import { useOrchestratorStore } from "../store/orchestrator-store";
import { CardOrchestrationSettingsForm } from "./CardOrchestrationSettingsForm";
interface DispatchSettings {version:number;nodeConcurrency:Record<string,number>}
export function CardDispatchTab({ api = cardRequest, orchestration }: { api?: typeof cardRequest; orchestration?: import("./CardOrchestrationSettingsForm").CardOrchestrationSettingsService } = {}) {
 const nodes=useOrchestratorStore(s=>s.nodes);
 const [settings,setSettings]=useState<DispatchSettings|null>(null),[values,setValues]=useState<Record<string,number>>({}),[pending,setPending]=useState(false),[error,setError]=useState<string|null>(null),[saved,setSaved]=useState(false);
 const load=async()=>{const {settings}=await api<{settings:DispatchSettings}>("/api/settings/card-dispatch");setSettings(settings);setValues(settings.nodeConcurrency);};
 useEffect(()=>{void load().catch(e=>setError(String(e)));},[]);
 const keys=[...new Set(["default",...nodes.keys(),...Object.keys(values)])];
 return <div className="space-y-8"><form className="space-y-4" onSubmit={e=>{e.preventDefault();if(!settings||pending)return;setPending(true);setError(null);setSaved(false);void api<{settings:DispatchSettings}>("/api/settings/card-dispatch","PUT",{expectedVersion:settings.version,nodeConcurrency:values}).then(result=>{setSettings(result.settings);setValues(result.settings.nodeConcurrency);setSaved(true);}).catch(async e=>{if(e instanceof CardApiError&&e.status===409){await load();setError("설정이 바뀌어 최신 값을 불러왔습니다. 확인 후 다시 저장하세요.");}else setError(String(e));}).finally(()=>setPending(false));}}>
  <h3 className="font-semibold">카드 실행</h3><p className="text-sm text-muted-foreground">노드별 동시 실행 상한</p>
  {settings?keys.map(key=><label key={key} className="flex items-center justify-between gap-4 text-sm"><span>{key==="default"?"기본값":key}</span><Input className="w-24" type="number" min={0} step={1} aria-label={`${key==="default"?"기본값":key} 동시 실행 상한`} placeholder={String(values.default)} value={values[key]??""} disabled={pending} onChange={e=>setValues(current=>{const next={...current};if(e.target.value===""&&key!=="default")delete next[key];else next[key]=Number(e.target.value);return next;})}/></label>):<p>불러오는 중…</p>}
  {error?<p role="alert" className="text-accent-red text-sm">{error}</p>:null}{saved?<p role="status" className="text-sm">저장했습니다.</p>:null}<Button type="submit" disabled={!settings||pending}>저장</Button>
 </form><CardOrchestrationSettingsForm service={orchestration}/></div>;
}
