import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, FrameLoading, Input, Switch } from "@seosoyoung/soul-ui";
import { CardApiError, cardRequest } from "@seosoyoung/soul-ui/cards/card-api";
import { useOrchestratorStore } from "../store/orchestrator-store";
import { CardOrchestrationSettingsForm } from "./CardOrchestrationSettingsForm";
import { V3ErrorNotice } from "../v3/V3ErrorNotice";
interface DispatchSettings {version:number;nodeConcurrency:Record<string,number>;reviewMeetsDependency?:boolean;startReleasedDependents?:boolean}
export function CardDispatchTab({ api = cardRequest, orchestration }: { api?: typeof cardRequest; orchestration?: import("./CardOrchestrationSettingsForm").CardOrchestrationSettingsService } = {}) {
 const { t } = useTranslation();
 const nodes=useOrchestratorStore(s=>s.nodes);
 const [settings,setSettings]=useState<DispatchSettings|null>(null),[values,setValues]=useState<Record<string,number>>({}),[pending,setPending]=useState(false),[error,setError]=useState<string|null>(null),[saved,setSaved]=useState(false),[loadError,setLoadError]=useState<string|null>(null);
 const [reviewMeetsDependency,setReviewMeetsDependency]=useState(false),[startReleasedDependents,setStartReleasedDependents]=useState(false);
 const apply=(value:DispatchSettings)=>{setSettings(value);setValues(value.nodeConcurrency);setReviewMeetsDependency(value.reviewMeetsDependency??false);setStartReleasedDependents(value.startReleasedDependents??false);};
 const load=async()=>{const {settings}=await api<{settings:DispatchSettings}>("/api/settings/card-dispatch");apply(settings);};
 const reload=()=>{setLoadError(null);void load().catch(e=>setLoadError(String(e)));};
 useEffect(reload,[]);
 const keys=[...new Set(["default",...nodes.keys(),...Object.keys(values)])];
 return <div className="space-y-8"><form className="space-y-4" onSubmit={e=>{e.preventDefault();if(!settings||pending)return;setPending(true);setError(null);setSaved(false);void api<{settings:DispatchSettings}>("/api/settings/card-dispatch","PUT",{expectedVersion:settings.version,nodeConcurrency:values,reviewMeetsDependency,startReleasedDependents}).then(result=>{apply(result.settings);setSaved(true);}).catch(async e=>{if(e instanceof CardApiError&&e.status===409){await load();setError(t("jobs.dispatch.conflict"));}else setError(String(e));}).finally(()=>setPending(false));}}>
  <h3 className="font-semibold">{t("jobs.dispatch.title")}</h3><p className="text-sm text-muted-foreground">{t("jobs.dispatch.nodeLimit")}</p>
  {settings?keys.map(key=><label key={key} className="flex items-center justify-between gap-4 text-sm"><span>{key==="default"?t("jobs.dispatch.defaultLimit"):key}</span><Input className="w-24" type="number" min={0} step={1} aria-label={t("jobs.dispatch.nodeLimitLabel", { node: key === "default" ? t("jobs.dispatch.defaultLimit") : key })} placeholder={String(values.default)} value={values[key]??""} disabled={pending} onChange={e=>setValues(current=>{const next={...current};if(e.target.value===""&&key!=="default")delete next[key];else next[key]=Number(e.target.value);return next;})}/></label>):loadError!==null?<V3ErrorNotice message={t("jobs.dispatch.loadError")} detail={loadError} onRetry={reload} retryLabel={t("jobs.common.reload")}/>:<FrameLoading inline label={t("jobs.common.loading")} />}
  {settings?<section className="space-y-4"><h3 className="font-semibold">{t("jobs.dispatch.prerequisites")}</h3>
   <label className="flex items-center justify-between gap-4 text-sm"><span>{t("jobs.dispatch.reviewMeetsDependency")}</span><Switch aria-label={t("jobs.dispatch.reviewMeetsDependency")} checked={reviewMeetsDependency} disabled={pending} onCheckedChange={setReviewMeetsDependency}/></label>
   <label className="flex items-center justify-between gap-4 text-sm"><span><span className="block">{t("jobs.dispatch.startReleasedDependents")}</span><span className="block text-muted-foreground">{t("jobs.dispatch.startReleasedHelp")}</span></span><Switch aria-label={t("jobs.dispatch.startReleasedDependents")} checked={startReleasedDependents} disabled={pending} onCheckedChange={setStartReleasedDependents}/></label>
  </section>:null}
  {error?<p role="alert" className="text-destructive-foreground text-sm" data-v3-selectable-content="true">{error}</p>:null}{saved?<p role="status" className="text-sm" data-v3-selectable-content="true">{t("jobs.common.saved")}</p>:null}<Button type="submit" disabled={!settings||pending}>{t("jobs.common.save")}</Button>
 </form><CardOrchestrationSettingsForm service={orchestration}/></div>;
}
