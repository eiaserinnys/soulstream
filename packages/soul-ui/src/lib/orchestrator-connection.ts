type ConnectionHint = "check" | "shutdown";
const listeners=new Set<(hint:ConnectionHint)=>void>();
export function subscribeOrchestratorHints(listener:(hint:ConnectionHint)=>void){listeners.add(listener);return ()=>{listeners.delete(listener);};}
export function requestOrchestratorCheck(){for(const listener of listeners)listener("check");}
export function notifyOrchestratorShutdown(){for(const listener of listeners)listener("shutdown");}

/** Observe only transport/gateway failures; preserve each API's response/error contract. */
export async function orchestratorFetch(fetchImplementation:typeof globalThis.fetch,...args:Parameters<typeof globalThis.fetch>):Promise<Response>{
 try{
  const response=await fetchImplementation(...args);
  if([502,503,504].includes(response.status))requestOrchestratorCheck();
  return response;
 }catch(error){
  if(!(error instanceof Error&&error.name==="AbortError"))requestOrchestratorCheck();
  throw error;
 }
}

const recoveryListeners = new Set<() => Promise<void>>();
export function registerConnectionRecovery(recover: () => Promise<void>) {
  recoveryListeners.add(recover);
  return () => { recoveryListeners.delete(recover); };
}
export async function resynchronizeDashboard() {
  await Promise.all([...recoveryListeners].map(async recover => {
    try { await recover(); }
    catch (error) {
      const status = typeof error === "object" && error !== null && "status" in error ? Number(error.status) : 0;
      // Existing API surfaces retain permission/validation/deletion errors after reconnection.
      if (status >= 400 && status < 500) return;
      throw error;
    }
  }));
}
