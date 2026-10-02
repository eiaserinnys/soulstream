import type { LiveDbSqlResolver } from '../runtime/live_db_sql.js';
import type { RuntimeSessionEventHub } from '../runtime/session_event_hub.js';
import { JevCardObservationPipeline } from './jev_card_observation_pipeline.js';
import { JevCardObservationDbRepository } from './jev_card_observation_repository.js';
export function createLiveJevCardObservation(options: {
  sqlResolver: LiveDbSqlResolver; apiKey: string | null; eventHub: Pick<RuntimeSessionEventHub,'publish'>;
  log(fields: Record<string,unknown>): void;
}) {
  return new JevCardObservationPipeline({ repository: new JevCardObservationDbRepository(options.sqlResolver), apiKey: options.apiKey,
    publish: (job,eventId,payload) => options.eventHub.publish({ nodeId:job.nodeId, data:{ type:'event', agentSessionId:job.sessionId, event:{ ...payload,_event_id:eventId } } }),
    log: options.log });
}
