export const title = 'Outbox: reconnect during publication';
export const state = v => v.stalePublished ? 'Stale connection used' : ({idle:'Waiting',reading:'Reading durable event','local-consumption':'Applying locally',published:'Waiting for ACK',dropped:'Discarding stale send'})[v.phase];
export const step = action => ({BeginFlush:'event is ready',Disconnect:'connection drops',Reconnect:'connection reconnects',ReadCompletes:'durable read finishes',LocalConsumptionCompletes:'local handling finishes',Acknowledged:'central ACK arrives',Rest:null})[action] ?? null;
export const group = v => v.stalePublished ? 'bad' : 'normal';
export const colors = {bad:'pink',normal:'blue'};
